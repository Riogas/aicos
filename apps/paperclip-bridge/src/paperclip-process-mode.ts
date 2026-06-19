/**
 * Paperclip process-adapter CLI mode.
 *
 * Invoked by Paperclip when an agent has work assigned. Paperclip spawns:
 *   aicos-bridge --paperclip-process-mode
 *
 * Auto-injected env (per Paperclip's buildPaperclipEnv):
 *   PAPERCLIP_AGENT_ID    - the agent.id (= paperclipAgentId in our registry)
 *   PAPERCLIP_COMPANY_ID  - the company id
 *   PAPERCLIP_API_URL     - e.g. http://localhost:3100
 *
 * Required custom env (set in agent.adapter_config.env):
 *   AICOS_API_KEY         - the agent's API key (from .secrets/agent-keys.json)
 *
 * NOTE on naming: we must NOT use PAPERCLIP_* prefix because Paperclip
 * heartbeat dispatch calls stripPaperclipRuntimeEnvBindings() which silently
 * filters ANY env key starting with "PAPERCLIP_" from adapter_config.env
 * before spawning the subprocess (see vendor/paperclip server/src/services/
 * heartbeat.ts:338-348). So we expose the agent token under AICOS_API_KEY.
 * Legacy PAPERCLIP_API_KEY is still accepted as a fallback in case someone
 * is invoking the CLI manually (where the strip doesn't apply).
 *
 * Optional:
 *   PAPERCLIP_RUN_ID      - heartbeat run id (auto-injected by some adapters)
 *
 * What this mode does:
 *  1. Identifies the agent via PAPERCLIP_AGENT_ID
 *  2. Queries Paperclip for in_progress issues assigned to this agent
 *  3. Picks the most recent one (the one Paperclip just dispatched)
 *  4. Executes the run via the same `executeRun` the HTTP server uses
 *  5. Posts comment + status back to Paperclip
 *  6. Writes a JSON summary to stdout (Paperclip parses for telemetry)
 *  7. Exits with code 0 on success, 1 on failure
 *
 * Because Paperclip natively tracks exit code and writes to heartbeat_runs,
 * this mode does NOT trigger the watchdog "missing disposition" escalation.
 */

import { mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { executeRun } from "./run.js";
import { PaperclipClient } from "./paperclip-client.js";
import {
  loadRegistry,
  resolvePersonaByPaperclipId,
  resolveWorkspaceByProjectId,
  resolveWorkspace,
} from "./registry.js";
import { createQuotaClient } from "./quota-client.js";
import { createLearningClient } from "./learning-client.js";
import { createPolicyClient } from "./policy-client.js";

interface PaperclipIssueListItem {
  id: string;
  identifier?: string | null;
  title?: string;
  description?: string | null;
  status: string;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  updatedAt?: string;
}

const TIMEOUT_MS = 8000;

/**
 * URL where the bridge HTTP server (running on the host) accepts stage events.
 * Inside the Paperclip container, the host is reachable as host.docker.internal.
 * Falls back to localhost when invoked directly on the host (manual CLI test).
 */
const BRIDGE_EVENT_URL =
  process.env.BRIDGE_EVENT_URL ?? "http://host.docker.internal:7100/stage";

async function reportStage(
  stage:
    | "dispatched"
    | "memory-retrieve"
    | "quota-select"
    | "cli-running"
    | "posting-result"
    | "done",
  payload: {
    runId: string;
    persona?: string;
    personaName?: string;
    ticketIdentifier?: string;
    cli?: string;
    model?: string;
  },
): Promise<void> {
  if (!payload.runId) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(BRIDGE_EVENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, ...payload }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {
    // Best-effort: missing tracker reports must not break the actual run.
  }
}

const BRIDGE_FINISHED_URL =
  process.env.BRIDGE_FINISHED_URL ?? "http://host.docker.internal:7100/internal/run-finished";

/**
 * Reporta el desenlace del run al bridge host para el motor de reintentos (#7).
 * Best-effort — un fallo acá no rompe el run.
 */
async function reportFinished(payload: { issueId: string; identifier?: string; disposition: string }): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    await fetch(BRIDGE_FINISHED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {
    /* el reintento no debe romper el run */
  }
}

const BRIDGE_OUTPUT_URL =
  process.env.BRIDGE_OUTPUT_URL ?? "http://host.docker.internal:7100/output";

/**
 * Stream a live output chunk to the bridge HTTP server (→ SSE → dashboard
 * AGENT UPLINK). Best-effort, fire-and-forget; never blocks/breaks the run.
 */
function reportOutput(payload: {
  runId: string;
  kind: "text" | "tool" | "thinking";
  text: string;
  persona?: string;
  personaName?: string;
  ticketIdentifier?: string;
}): void {
  if (!payload.runId) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  void fetch(BRIDGE_OUTPUT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .catch(() => {
      /* missing uplink must not break the run */
    })
    .finally(() => clearTimeout(t));
}

async function fetchAssignedIssues(
  apiUrl: string,
  apiKey: string,
  companyId: string,
  agentId: string,
): Promise<PaperclipIssueListItem[]> {
  // Paperclip's list endpoint only supports ?status=<single> (statusIn is silently
  // ignored). When dispatched by Paperclip, the issue we want is in 'in_progress'
  // because dispatch already promoted it. Filter strictly by that to avoid
  // accidentally picking up an unrelated 'todo' that's still queued.
  const url = `${apiUrl}/api/companies/${companyId}/issues?assigneeAgentId=${agentId}&status=in_progress`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      process.stderr.write(`[process-mode] list issues HTTP ${r.status}\n`);
      return [];
    }
    const data = (await r.json()) as PaperclipIssueListItem[] | { items: PaperclipIssueListItem[] };
    const items = Array.isArray(data) ? data : (data.items ?? []);
    return items;
  } catch (e) {
    process.stderr.write(`[process-mode] list issues fail: ${(e as Error).message}\n`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch a project's display name (for the greenfield workspace convention).
 * Returns null on any error — caller degrades to "no workspace".
 */
async function fetchProjectName(
  apiUrl: string,
  apiKey: string,
  projectId: string,
): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${apiUrl}/api/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { name?: string; project?: { name?: string } };
    return data.name ?? data.project?.name ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function pickIssue(items: PaperclipIssueListItem[]): Promise<PaperclipIssueListItem | null> {
  if (items.length === 0) return null;
  // Strict: only in_progress (we narrowed the query to that). If somehow
  // multiple are in_progress (shouldn't happen per-agent), pick the most recently
  // updated one — Paperclip just bumped its updated_at on dispatch.
  const inProgress = items.filter((i) => i.status === "in_progress");
  if (inProgress.length === 0) return null;
  inProgress.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return inProgress[0]!;
}

export async function runPaperclipProcessMode(): Promise<number> {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  // Read the agent API key from the AICOS-prefixed env (the canonical name for
  // process adapter use). Accept PAPERCLIP_API_KEY too for direct CLI invocations.
  const apiKey = process.env.AICOS_API_KEY ?? process.env.PAPERCLIP_API_KEY;
  const agentId = process.env.PAPERCLIP_AGENT_ID;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const runId = process.env.PAPERCLIP_RUN_ID;

  if (!apiUrl || !agentId || !companyId) {
    process.stderr.write(
      `[process-mode] missing required env: PAPERCLIP_API_URL=${!!apiUrl} PAPERCLIP_AGENT_ID=${!!agentId} PAPERCLIP_COMPANY_ID=${!!companyId}\n`,
    );
    return 2;
  }
  if (!apiKey) {
    process.stderr.write(
      `[process-mode] missing AICOS_API_KEY (must be in agent.adapter_config.env — Paperclip strips PAPERCLIP_* keys)\n`,
    );
    return 2;
  }

  // Load registry (need persona lookup by paperclipAgentId)
  const stats = loadRegistry();
  if (!stats.resolvable || stats.resolvable === 0) {
    process.stderr.write(`[process-mode] registry has 0 resolvable agents\n`);
    return 2;
  }

  const persona = resolvePersonaByPaperclipId(agentId);
  if (!persona) {
    process.stderr.write(
      `[process-mode] no persona in registry for paperclipAgentId=${agentId}\n`,
    );
    return 2;
  }

  // Find the issue this dispatch is for
  const items = await fetchAssignedIssues(apiUrl, apiKey, companyId, agentId);
  const issue = await pickIssue(items);
  if (!issue) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason: "no assigned issue in todo/in_progress",
        persona: persona.registryId,
      }) + "\n",
    );
    return 0;
  }

  process.stderr.write(
    `[process-mode] picked ${issue.identifier ?? issue.id} (status=${issue.status}) for ${persona.registryId}\n`,
  );

  // Synthesize a stable runId for the tracker if Paperclip didn't pass one.
  // Without a runId we cannot tie stage events together; the bridge tracker
  // would create one synthetic run per event.
  const effectiveRunId = runId ?? `process-${issue.id}-${Date.now()}`;

  // Tell the dashboard "this agent is now actively in flight on this ticket".
  await reportStage("dispatched", {
    runId: effectiveRunId,
    persona: persona.registryId,
    personaName: persona.agentName,
    ticketIdentifier: issue.identifier ?? undefined,
  });

  // Build workspace from project_id mapping (registry/project-workspaces.json).
  // If the project isn't mapped, apply the GREENFIELD CONVENTION: fetch its
  // name and default the cwd to ~/Projects/<slug>, creating the dir so the
  // agent's `cd` lands. Mapped projects are unchanged.
  let workspace = issue.projectId ? resolveWorkspaceByProjectId(issue.projectId) : null;
  if (!workspace && issue.projectId) {
    const projectName = await fetchProjectName(apiUrl, apiKey, issue.projectId);
    workspace = resolveWorkspace(issue.projectId, projectName);
    if (workspace) {
      try {
        mkdirSync(workspace.cwd, { recursive: true });
        // git-init best-effort so auto-commit funciona desde el primer run.
        if (!existsSync(join(workspace.cwd, ".git"))) {
          execFileSync("git", ["init", "-b", workspace.defaultBranch], {
            cwd: workspace.cwd,
            stdio: "ignore",
          });
        }
      } catch (e) {
        process.stderr.write(
          `[process-mode] greenfield cwd ${workspace.cwd} setup warn: ${(e as Error).message}\n`,
        );
      }
      process.stderr.write(
        `[process-mode] greenfield workspace ${workspace.cwd} (proyecto "${projectName}")\n`,
      );
    }
  }

  // Construct prompt — Paperclip already auto-marked status to in_progress when
  // dispatching, so we directly read the issue and execute.
  const prompt = [
    `Ticket: ${issue.identifier ?? issue.id}`,
    `Title: ${issue.title ?? "(sin titulo)"}`,
    "",
    issue.description ?? "(sin descripcion)",
  ].join("\n");

  // Construct the PaperclipClient using OUR agent key + runId from env
  const pcClient = new PaperclipClient({ apiUrl, apiKey }, runId);

  // Same clients as the HTTP server uses
  const quotaClient = createQuotaClient(process.env.QUOTA_SERVICE_URL);
  const learningClient = createLearningClient(process.env.LEARNING_SERVICE_URL);
  const policyClient = createPolicyClient(process.env.POLICY_SERVICE_URL);

  // Bridge HTTP tracker isn't reachable from inside this subprocess (different
  // address space), so we wire executeRun with a lightweight tracker shim that
  // POSTs each stage change to the bridge via reportStage().
  const remoteTracker = {
    setStage: (rid: string, stage: string, extra?: { cli?: string; model?: string }) => {
      void reportStage(stage as never, {
        runId: rid,
        persona: persona.registryId,
        personaName: persona.agentName,
        ticketIdentifier: issue.identifier ?? undefined,
        cli: extra?.cli,
        model: extra?.model,
      });
    },
  } as unknown as Parameters<typeof executeRun>[0]["tracker"];

  const result = await executeRun({
    prompt,
    persona,
    workspace,
    ticketIdentifier: issue.identifier ?? undefined,
    paperclip: { client: pcClient, issueId: issue.id },
    quotaClient,
    learningClient,
    policyClient,
    tracker: remoteTracker,
    runId: effectiveRunId,
    onOutput: (chunk) =>
      reportOutput({
        runId: effectiveRunId,
        kind: chunk.kind,
        text: chunk.text,
        persona: persona.registryId,
        personaName: persona.agentName,
        ticketIdentifier: issue.identifier ?? undefined,
      }),
  });

  // Final transition — the bridge will keep the entry around for DONE_TTL_MS
  // so SSE clients see the closing event.
  await reportStage("done", {
    runId: effectiveRunId,
    persona: persona.registryId,
    personaName: persona.agentName,
    ticketIdentifier: issue.identifier ?? undefined,
  });

  const summary = {
    ok: result.exitCode === 0,
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    persona: persona.registryId,
    mode: result.mode,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputLen: result.output.length,
    runId: runId ?? null,
  };
  // Paperclip captures stdout as resultJson.stdout for the heartbeat_run.
  process.stdout.write(JSON.stringify(summary) + "\n");

  // Reporta el desenlace al bridge host → motor de reintentos/escalado (#7).
  await reportFinished({
    issueId: issue.id,
    identifier: issue.identifier ?? undefined,
    disposition: result.disposition,
  });

  return result.exitCode === 0 ? 0 : 1;
}
