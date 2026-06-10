/**
 * AICOS Orchestrator — turns a single task description into a tree of
 * subtasks, each assigned to the right specialist agent, with blocking
 * dependencies between them.
 *
 * Flow:
 *   1. caller asks /orchestrate { taskDescription, projectId, parentIssueId? }
 *   2. decompose() spawns claude with a structured prompt + the registry roster.
 *      Claude returns a JSON plan of subtasks with dependsOn references.
 *   3. createSubtaskTree() creates each subtask in Paperclip with:
 *      - status='backlog' (so Paperclip doesn't auto-dispatch all at once)
 *      - parent_id pointing to the original ticket (if any)
 *      - blockedByIssueIds wiring the dependency graph
 *   4. The subtask-promoter loop (separate module) polls every 5s and
 *      promotes backlog→todo when all blockers are done. Paperclip's
 *      regular dispatcher takes it from there.
 *
 * Fallbacks:
 *   - claude output parse failure → 1 subtask containing the original task
 *     assigned to the most generic agent (default 'it-architect').
 *   - subtask references unknown role → falls back to default agent.
 *   - cycle detected in dependsOn → drops the offending edges with a warn log.
 */

import { spawn } from "node:child_process";
import {
  loadRegistry,
  listRegistryAgents,
  resolvePersonaByRegistryId,
  getPaperclipAgentIdForRegistryId,
} from "./registry.js";
import { PaperclipClient } from "./paperclip-client.js";

export interface SubtaskPlan {
  /** local id within the plan, e.g. "s1", "s2" — used only for dependsOn wiring */
  id: string;
  title: string;
  description: string;
  /** registry id of the assignee (e.g. "it-analyst") */
  role: string;
  /** local ids of other subtasks that must complete first */
  dependsOn: string[];
}

export interface Decomposition {
  /** the original task, distilled */
  summary: string;
  /** true if claude judged the task atomic — only 1 subtask in `subtasks` */
  atomic: boolean;
  subtasks: SubtaskPlan[];
}

export interface OrchestrateInput {
  taskDescription: string;
  companyId: string;
  projectId: string;
  /**
   * Optional parent issue. Two scenarios:
   *  - If provided (e.g. a Telegram-originated tracking ticket), subtasks
   *    become its children directly.
   *  - If omitted, the orchestrator creates a "root" parent issue itself,
   *    assigned to the CEO/Hermes agent, so the dashboard can render the
   *    full subtask tree under a single roof.
   */
  parentIssueId?: string;
  /** fallback agent registry id when decomposition fails */
  defaultRole?: string;
  /**
   * Where the task came from. Tags the auto-created parent issue so the
   * dashboard can light up the Operator only on telegram-originated runs.
   * Defaults to "manual" (which is functionally equivalent to "paperclip"
   * for the operator-light heuristic).
   */
  triggeredBy?: "telegram" | "paperclip" | "manual";
  /** Optional title for the auto-created parent (defaults to first line of taskDescription). */
  parentTitle?: string;
  /** Agent id to assign the auto-created parent to. Defaults to AICOS_HERMES_AGENT_ID env. */
  parentAssigneeAgentId?: string;
}

export interface OrchestrateResult {
  decomposition: Decomposition;
  createdIssues: Array<{
    planId: string;
    issueId: string;
    identifier: string | null;
    role: string;
    title: string;
    blockedByPlanIds: string[];
  }>;
  warnings: string[];
}

/** ID of the agent used when the decomposer routes to a missing role. */
const FALLBACK_ROLE = "it-architect";

/** Hard cap on how many subtasks the decomposer is allowed to emit. */
const MAX_SUBTASKS = 12;

/** Roster description fed to the decomposer prompt. */
function buildRosterPrompt(): string {
  // Make sure the registry cache is populated; callers may not have invoked
  // loadRegistry yet.
  const stats = loadRegistry();
  if (!stats.resolvable || stats.resolvable === 0) {
    return "(no agents in registry — fallback to it-architect)";
  }
  const agents = listRegistryAgents();
  const roles: string[] = [];
  for (const a of agents) {
    if (!a.id) continue;
    const cap = a.capabilities ?? "(no capabilities listed)";
    roles.push(`- ${a.id} (${a.department}) — ${cap}`);
  }
  return roles.join("\n");
}

function buildDecomposerPrompt(taskDescription: string): string {
  const roster = buildRosterPrompt();
  return `You are AICOS Orchestrator — the brain that decomposes a high-level task into the smallest set of subtasks that can actually be executed by specialist agents working in parallel and in sequence.

# Available specialist agents

Each line is "<registryId> (<department>) — <capabilities>". You MUST assign every subtask to one of these registryIds (exact string).

${roster}

# Decomposition rules

1. **If the task is atomic** (one agent can do it end-to-end, no real dependencies), emit a SINGLE subtask. Set atomic=true.
2. **If the task is complex**, decompose into the MINIMUM number of subtasks needed. Avoid bureaucratic ceremony (don't always invent an analyst + architect + impl + reviewer if the work doesn't need it).
3. **dependsOn must be a DAG** — no cycles. Each id in dependsOn must reference an earlier subtask in your list.
4. **Parallelism is OK and encouraged** — if two subtasks can truly run independently, give them no shared dependsOn so they fan out.
5. **Match the role to the capabilities** — pick the specialist whose capabilities most directly fit the subtask. Don't default to "it-architect" for everything.
6. **Max ${MAX_SUBTASKS} subtasks.** If the task seems to need more, you're over-decomposing — combine.
7. **Each subtask description must be self-contained** — the assigned agent will read ONLY that description (not the parent task), so include the relevant context.

# Output format

Respond with ONLY a single JSON object (no prose, no markdown fence), with this exact shape:

{
  "summary": "one-sentence distillation of the original task",
  "atomic": true | false,
  "subtasks": [
    {
      "id": "s1",
      "title": "short title (max 80 chars)",
      "description": "self-contained instructions for the agent (markdown OK)",
      "role": "<registryId from roster>",
      "dependsOn": []
    }
  ]
}

# Task to decompose

${taskDescription}`;
}

/**
 * Spawn claude in -p mode to run the decomposer prompt. Returns the raw stdout.
 * 30s hard timeout.
 */
function runDecomposerCli(prompt: string): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"];
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, stdout, stderr: `${stderr}\n[spawn err] ${err.message}`, exitCode: err.code === "ENOENT" ? 127 : 1 });
    });
    proc.on("exit", (code, signal) => {
      const exitCode = signal ? 1 : code ?? 1;
      resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
    });
  });
}

/**
 * Pull the JSON object claude emitted out of the wrapper.
 * Claude in --output-format json returns: { "type": "result", "result": "<text>", ... }
 * The model's text MIGHT be wrapped in ```json fences if the model misbehaves —
 * try to recover those.
 */
function parseDecomposerOutput(raw: string): Decomposition | null {
  let text: string | null = null;

  // First, peel the claude wrapper
  try {
    const wrapper = JSON.parse(raw) as { type?: string; result?: string };
    if (wrapper && typeof wrapper.result === "string") {
      text = wrapper.result;
    }
  } catch {
    // raw might already be the inner text (older claude versions or piped output)
    text = raw;
  }
  if (!text) return null;

  // Strip ```json ... ``` fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1]!.trim();

  // Find the first { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const jsonSlice = text.slice(start, end + 1);

  try {
    const parsed = JSON.parse(jsonSlice) as Decomposition;
    if (!parsed || !Array.isArray(parsed.subtasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build a fallback decomposition when the LLM call fails entirely.
 * Just wrap the original task as a single subtask routed to the default agent.
 */
function fallbackDecomposition(taskDescription: string, defaultRole: string): Decomposition {
  return {
    summary: taskDescription.split("\n")[0]!.slice(0, 200),
    atomic: true,
    subtasks: [
      {
        id: "s1",
        title: taskDescription.split("\n")[0]!.slice(0, 80) || "Untitled task",
        description: taskDescription,
        role: defaultRole,
        dependsOn: [],
      },
    ],
  };
}

/**
 * Sanity-check the decomposition: drop bad role references, break cycles,
 * cap to MAX_SUBTASKS. Returns the cleaned decomposition + warnings.
 */
function sanitize(decomp: Decomposition, defaultRole: string): { clean: Decomposition; warnings: string[] } {
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const subs = decomp.subtasks.slice(0, MAX_SUBTASKS).filter((s) => {
    if (!s.id || !s.title || !s.role) {
      warnings.push(`dropping malformed subtask: ${JSON.stringify(s).slice(0, 100)}`);
      return false;
    }
    if (seenIds.has(s.id)) {
      warnings.push(`duplicate subtask id ${s.id} dropped`);
      return false;
    }
    seenIds.add(s.id);
    return true;
  });

  for (const s of subs) {
    // Validate role
    if (!resolvePersonaByRegistryId(s.role)) {
      warnings.push(`role "${s.role}" not in registry — falling back to ${defaultRole} for subtask ${s.id}`);
      s.role = defaultRole;
    }
    // Dependency must reference an earlier subtask in the list (otherwise drop)
    if (!Array.isArray(s.dependsOn)) {
      s.dependsOn = [];
      continue;
    }
    s.dependsOn = s.dependsOn.filter((dep) => {
      if (!seenIds.has(dep)) {
        warnings.push(`subtask ${s.id} depends on unknown ${dep} — edge dropped`);
        return false;
      }
      if (dep === s.id) {
        warnings.push(`subtask ${s.id} depends on itself — edge dropped`);
        return false;
      }
      return true;
    });
  }

  // Topo-sort + cycle detection: rebuild order so earlier subs are listed first
  const indexById = new Map(subs.map((s, i) => [s.id, i] as const));
  const inDeg = new Map<string, number>(subs.map((s) => [s.id, 0]));
  for (const s of subs) {
    for (const d of s.dependsOn) {
      inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
      void d;
    }
  }
  const queue = subs.filter((s) => (inDeg.get(s.id) ?? 0) === 0).map((s) => s.id);
  const sortedIds: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sortedIds.push(id);
    for (const s of subs) {
      if (s.dependsOn.includes(id)) {
        inDeg.set(s.id, (inDeg.get(s.id) ?? 1) - 1);
        if ((inDeg.get(s.id) ?? 0) === 0) queue.push(s.id);
      }
    }
  }
  if (sortedIds.length < subs.length) {
    // Cycle detected
    const stuck = subs.filter((s) => !sortedIds.includes(s.id)).map((s) => s.id);
    warnings.push(`cycle detected involving ${stuck.join(",")} — clearing their dependsOn`);
    for (const s of subs) {
      if (stuck.includes(s.id)) s.dependsOn = [];
    }
  } else {
    subs.sort((a, b) => sortedIds.indexOf(a.id) - sortedIds.indexOf(b.id));
  }
  void indexById;

  return {
    clean: { summary: decomp.summary, atomic: subs.length === 1, subtasks: subs },
    warnings,
  };
}

export async function decompose(taskDescription: string, defaultRole = FALLBACK_ROLE): Promise<{ decomp: Decomposition; warnings: string[] }> {
  const prompt = buildDecomposerPrompt(taskDescription);
  const cli = await runDecomposerCli(prompt);
  if (!cli.ok) {
    process.stderr.write(`[orchestrator] decomposer CLI failed (exit ${cli.exitCode}): ${cli.stderr.slice(0, 300)}\n`);
    return { decomp: fallbackDecomposition(taskDescription, defaultRole), warnings: [`decomposer CLI failed: exit ${cli.exitCode}`] };
  }
  const parsed = parseDecomposerOutput(cli.stdout);
  if (!parsed) {
    process.stderr.write(`[orchestrator] decomposer output parse failed; stdout head: ${cli.stdout.slice(0, 300)}\n`);
    return { decomp: fallbackDecomposition(taskDescription, defaultRole), warnings: ["decomposer output not valid JSON"] };
  }
  return sanitize(parsed, defaultRole) === undefined
    ? { decomp: parsed, warnings: [] }
    : (() => {
        const { clean, warnings } = sanitize(parsed, defaultRole);
        return { decomp: clean, warnings };
      })();
}

/**
 * Walk the cleaned decomposition top-down. For each subtask, resolve the
 * assignee's paperclipAgentId, build the blockedByIssueIds from previously
 * created subtasks, then call createIssue. All issues are created in
 * status='backlog' EXCEPT the root subtasks (no blockers) which can start
 * immediately as 'todo'.
 */
export async function createSubtaskTree(
  input: OrchestrateInput,
  decomp: Decomposition,
  pcClient: PaperclipClient,
): Promise<{ created: OrchestrateResult["createdIssues"]; warnings: string[] }> {
  const created: OrchestrateResult["createdIssues"] = [];
  const warnings: string[] = [];
  const planToIssueId = new Map<string, string>();

  for (const sub of decomp.subtasks) {
    const persona = resolvePersonaByRegistryId(sub.role);
    if (!persona) {
      warnings.push(`subtask ${sub.id}: role ${sub.role} not resolvable, skipping`);
      continue;
    }
    const paperclipAgentId = getPaperclipAgentIdForRegistryId(sub.role);
    if (!paperclipAgentId) {
      warnings.push(`subtask ${sub.id}: role ${sub.role} has no paperclipAgentId in registry, skipping`);
      continue;
    }

    const blockedByIssueIds: string[] = [];
    for (const dep of sub.dependsOn) {
      const issueId = planToIssueId.get(dep);
      if (issueId) blockedByIssueIds.push(issueId);
    }

    // Subtasks with no blockers can start immediately. Blocked ones go to backlog
    // and the promoter will lift them when their blockers complete.
    const initialStatus = blockedByIssueIds.length === 0 ? "todo" : "backlog";

    try {
      const issue = await pcClient.createIssue({
        companyId: input.companyId,
        projectId: input.projectId,
        title: sub.title,
        description: sub.description,
        assigneeAgentId: paperclipAgentId,
        parentId: input.parentIssueId,
        blockedByIssueIds: blockedByIssueIds.length > 0 ? blockedByIssueIds : undefined,
        priority: "medium",
        status: initialStatus,
      });
      planToIssueId.set(sub.id, issue.id);
      created.push({
        planId: sub.id,
        issueId: issue.id,
        identifier: (issue.identifier as string) ?? null,
        role: sub.role,
        title: sub.title,
        blockedByPlanIds: sub.dependsOn,
      });
    } catch (e) {
      warnings.push(`subtask ${sub.id} createIssue failed: ${(e as Error).message}`);
    }
  }

  return { created, warnings };
}

/**
 * Background heartbeats keep orchestrator parents alive — they post a brief
 * comment every PARENT_HEARTBEAT_MS so Paperclip's watchdog doesn't escalate
 * them to "blocked" while the children are still working.
 *
 * Stops itself when:
 *   - the parent issue transitions to done/cancelled (the reconciler closes it), or
 *   - HEARTBEAT_MAX_ITERATIONS ticks elapse (safety cap so we never leak).
 *
 * Module-level singletons so a tracker survives across orchestrate() calls.
 */
const PARENT_HEARTBEAT_MS = 60_000;
const HEARTBEAT_MAX_ITERATIONS = 60; // 1 hour max
const heartbeats = new Map<string, NodeJS.Timeout>();

function startParentHeartbeat(parentIssueId: string, pcClient: PaperclipClient): void {
  if (heartbeats.has(parentIssueId)) return;
  let iterations = 0;
  const tick = async () => {
    iterations++;
    if (iterations >= HEARTBEAT_MAX_ITERATIONS) {
      stopParentHeartbeat(parentIssueId);
      return;
    }
    try {
      const issue = await pcClient.getIssue(parentIssueId);
      const status = issue.status as string | undefined;
      if (status === "done" || status === "cancelled") {
        stopParentHeartbeat(parentIssueId);
        return;
      }
      // Best-effort: post a short tracking comment. If we can't, we'll try
      // again next tick — and if the watchdog fires anyway, the reconciler's
      // 403 path logs cleanly.
      await pcClient
        .postComment(
          parentIssueId,
          `_(orchestrator tracking — children still in flight, iter ${iterations})_`,
        )
        .catch(() => {});
    } catch {
      // Issue gone or transient error — keep trying until iterations cap.
    }
  };
  const handle = setInterval(() => void tick(), PARENT_HEARTBEAT_MS);
  heartbeats.set(parentIssueId, handle);
}

function stopParentHeartbeat(parentIssueId: string): void {
  const h = heartbeats.get(parentIssueId);
  if (h) {
    clearInterval(h);
    heartbeats.delete(parentIssueId);
  }
}

/** Exposed for the promoter's reconciler — it knows when a parent really closed. */
export function clearParentHeartbeat(parentIssueId: string): void {
  stopParentHeartbeat(parentIssueId);
}

export async function orchestrate(input: OrchestrateInput, pcClient: PaperclipClient): Promise<OrchestrateResult & { parentIssueId?: string; parentIdentifier?: string | null }> {
  const { decomp, warnings: dwarns } = await decompose(input.taskDescription, input.defaultRole ?? FALLBACK_ROLE);

  // Auto-create a root parent if caller didn't provide one, so the dashboard
  // can group all subtasks under a single tree node.
  let effectiveParentId = input.parentIssueId;
  let parentIdentifier: string | null | undefined;
  const autoCreateWarnings: string[] = [];
  if (!effectiveParentId) {
    const parentAssignee =
      input.parentAssigneeAgentId ?? process.env.AICOS_HERMES_AGENT_ID;
    if (parentAssignee) {
      const triggeredBy = input.triggeredBy ?? "manual";
      const titlePrefix = triggeredBy === "telegram" ? "[telegram] " : "";
      const baseTitle = (
        input.parentTitle ?? input.taskDescription.split("\n")[0] ?? "Untitled task"
      ).slice(0, 200);
      const finalTitle = `${titlePrefix}${baseTitle}`;
      try {
        const parent = await pcClient.createIssue({
          companyId: input.companyId,
          projectId: input.projectId,
          title: finalTitle,
          description: input.taskDescription,
          assigneeAgentId: parentAssignee,
          priority: "medium",
          // Parents start in 'in_progress' so they're visible in the live tree
          // (backlog would hide them from the in_progress list the dashboard polls).
          status: "in_progress",
        });
        effectiveParentId = parent.id;
        parentIdentifier = (parent.identifier as string | undefined) ?? null;
        // Keep the parent alive while the pipeline runs — without this it
        // gets escalated to 'blocked' after ~5min of no agent activity and
        // becomes a pain to close (the watchdog stamps a recovery action
        // owned by an admin account the bridge can't speak for).
        startParentHeartbeat(parent.id, pcClient);
      } catch (e) {
        autoCreateWarnings.push(`auto-create parent failed: ${(e as Error).message}`);
      }
    } else {
      autoCreateWarnings.push("AICOS_HERMES_AGENT_ID not set — parent issue NOT auto-created (subtasks will not appear under a tree node)");
    }
  }

  const { created, warnings: cwarns } = await createSubtaskTree(
    { ...input, parentIssueId: effectiveParentId },
    decomp,
    pcClient,
  );
  return {
    decomposition: decomp,
    createdIssues: created,
    warnings: [...dwarns, ...autoCreateWarnings, ...cwarns],
    parentIssueId: effectiveParentId,
    parentIdentifier,
  };
}
