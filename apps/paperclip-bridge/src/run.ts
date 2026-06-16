import { spawn } from "node:child_process";
import { runHermesOneshotCaptured } from "./hermes.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { PersonaResolution, ProjectWorkspace } from "./registry.js";
import { buildPersonaPrompt } from "./registry.js";
import { invokeCli, buildDirectCliPrompt } from "./cli-direct.js";
import type { SupportedCli } from "./cli-direct.js";
import {
  retrieveAllScopes,
  storeMemory,
  formatMemoriesForPrompt,
} from "./memory.js";
import type { QuotaClient } from "./quota-client.js";
import { buildCandidates, inferProvider } from "./provider-map.js";
import type { LearningClient } from "./learning-client.js";
import type { InFlightTracker } from "./in-flight-tracker.js";
import type { PolicyClient } from "./policy-client.js";

interface CommitResult {
  attempted: boolean;
  committed: boolean;
  hadChanges: boolean;
  commitSha: string | null;
  stderr: string;
}

function gitRun(
  cwd: string,
  args: string[],
  authorEmail: string,
  authorName: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: authorName,
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    proc.on("error", (err) =>
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` }),
    );
    proc.on("exit", (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
  });
}

async function autoCommitWorkspace(
  workspace: ProjectWorkspace,
  persona: PersonaResolution,
  ticketTitle: string,
  ticketIdentifier?: string,
): Promise<CommitResult> {
  const cwd = workspace.cwd;
  const email = `${persona.registryId}@aicos.local`;
  const name = persona.agentName;

  // 1. status --porcelain para saber si hay cambios
  const status = await gitRun(cwd, ["status", "--porcelain"], email, name);
  if (status.code !== 0) {
    return {
      attempted: true,
      committed: false,
      hadChanges: false,
      commitSha: null,
      stderr: `git status fail: ${status.stderr}`,
    };
  }
  if (status.stdout.trim() === "") {
    return {
      attempted: true,
      committed: false,
      hadChanges: false,
      commitSha: null,
      stderr: "",
    };
  }

  // 2. add -A
  const add = await gitRun(cwd, ["add", "-A"], email, name);
  if (add.code !== 0) {
    return {
      attempted: true,
      committed: false,
      hadChanges: true,
      commitSha: null,
      stderr: `git add fail: ${add.stderr}`,
    };
  }

  // 3. commit
  const msgLines = [
    `${persona.agentName}: ${ticketTitle.slice(0, 60)}`,
    "",
    `Auto-commit by AICOS bridge.`,
    `Agent: ${persona.agentName} (${persona.registryId})`,
    ticketIdentifier ? `Ticket: ${ticketIdentifier}` : "",
    `CLI: ${persona.preferredModel?.cli}/${persona.preferredModel?.model ?? ""}`,
  ].filter(Boolean);
  const commit = await gitRun(
    cwd,
    ["commit", "-m", msgLines.join("\n")],
    email,
    name,
  );
  if (commit.code !== 0) {
    return {
      attempted: true,
      committed: false,
      hadChanges: true,
      commitSha: null,
      stderr: `git commit fail: ${commit.stderr}`,
    };
  }

  // 4. capture sha
  const sha = await gitRun(cwd, ["rev-parse", "HEAD"], email, name);
  return {
    attempted: true,
    committed: true,
    hadChanges: true,
    commitSha: sha.code === 0 ? sha.stdout.trim().slice(0, 12) : null,
    stderr: "",
  };
}

export interface ExecuteRunInput {
  prompt: string;
  model?: string;
  provider?: string;
  persona?: PersonaResolution;
  workspace?: ProjectWorkspace | null;
  ticketIdentifier?: string;
  paperclip?: {
    client: PaperclipClient;
    issueId: string;
  };
  quotaClient?: QuotaClient;
  learningClient?: LearningClient;
  task?: "trivial" | "bug-fix" | "small-feature" | "critical" | "large-context";
  /** Optional in-flight tracker. Used to emit stage transitions for SSE. */
  tracker?: InFlightTracker;
  /** Key used by the tracker to identify this run. Defaults to nothing (no stage events). */
  runId?: string;
  /** Live output stream callback — invoked per CLI output chunk for the dashboard uplink. */
  onOutput?: (chunk: { kind: "text" | "tool" | "thinking"; text: string }) => void;
  /** Optional policy engine client. If present and decision=deny, the run aborts before any CLI spawn. */
  policyClient?: PolicyClient;
  /**
   * Skip the policy gate. Set by the /approve endpoint when the run is being
   * re-launched after a previous "require_approval" verdict was approved.
   * Without this, the second run would just stall on policy again.
   */
  approved?: boolean;
}

export interface ExecuteRunResult {
  exitCode: number;
  output: string;
  durationMs: number;
  mode: "direct-cli" | "hermes-oneshot" | "hermes-fallback";
}

const KNOWN_CLIS: ReadonlyArray<SupportedCli> = [
  "claude",
  "codex",
  "agy",
  "opencode",
  "hermes",
];

function asCli(name: string | undefined): SupportedCli | null {
  if (!name) return null;
  return KNOWN_CLIS.includes(name as SupportedCli)
    ? (name as SupportedCli)
    : null;
}

export async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
  const start = Date.now();
  const pc = input.paperclip;

  if (pc) {
    try {
      await pc.client.updateStatus(pc.issueId, "in_progress");
    } catch (e) {
      process.stderr.write(
        `updateStatus(in_progress) warn: ${(e as Error).message}\n`,
      );
    }
  }

  const reportStage = (
    stage: "memory-retrieve" | "quota-select" | "cli-running" | "posting-result",
    patch?: { cli?: string; model?: string },
  ) => {
    if (input.tracker && input.runId) {
      input.tracker.setStage(input.runId, stage, patch);
    }
  };

  // Memory retrieval (L4 — 4 scopes). Done ONCE before the retry loop because
  // memory context doesn't depend on which CLI we end up using.
  let memoryBlock = "";
  if (input.persona) {
    reportStage("memory-retrieve");
    try {
      const mems = await retrieveAllScopes(input.prompt, {
        registryId: input.persona.registryId,
        projectId: input.workspace?.projectName,
        perScopeLimit: 2,
      });
      if (mems.length > 0) {
        memoryBlock = formatMemoriesForPrompt(mems);
        const byScope = mems.reduce<Record<string, number>>((acc, m) => {
          acc[m.scope] = (acc[m.scope] ?? 0) + 1;
          return acc;
        }, {});
        process.stderr.write(
          `[memory] retrieved ${mems.length} (${Object.entries(byScope).map(([s, n]) => `${s}:${n}`).join(", ")}) for ${input.persona.registryId}\n`,
        );
      }
    } catch (e) {
      process.stderr.write(`[memory] retrieve warn: ${(e as Error).message}\n`);
    }
  }

  // Build candidate chain (preferred + fallbackChain) ordered exactly as the
  // registry says. The retry loop walks this list and tries each until one
  // succeeds. Quota /select is re-consulted per attempt so that a provider
  // marked-down after a previous failure gets skipped automatically.
  const candidates = input.persona
    ? buildCandidates(input.persona.preferredModel, input.persona.fallbackChain)
    : [];

  // Cooldown threshold: after AUTO_COOLDOWN_FAIL_THRESHOLD consecutive failures
  // of the same provider in this single executeRun, the bridge tells the quota
  // manager to mark that provider down for AUTO_COOLDOWN_SEC seconds. Other
  // concurrent runs (and the next attempt of this one) then skip it via /select.
  const AUTO_COOLDOWN_FAIL_THRESHOLD = 2;
  const AUTO_COOLDOWN_SEC = 300; // 5 min
  const failuresByProvider = new Map<string, number>();

  // Result holders — filled by the loop. Defaults assume nothing ran.
  let exitCode = -1;
  let output = "";
  let stderr = "";
  let mode: ExecuteRunResult["mode"] = "direct-cli";
  let effectiveCli: string | undefined;
  let effectiveModel: string | undefined;
  let effectiveProvider: string | undefined;
  let costUsd = 0;
  let tokens: { input?: number; output?: number; cached?: number } | undefined;
  let attemptCount = 0;

  // Policy gate: ask the engine to evaluate the run BEFORE we spawn any CLI.
  // Fail-open if no client is configured. A deny result skips the entire
  // direct-cli path and the run completes with exitCode=2.
  //
  // `input.approved` bypasses the gate — this is what /approve sets when
  // re-launching a held run, so the policy doesn't re-stall it.
  if (!input.approved && input.policyClient?.isEnabled() && input.persona) {
    const verdict = await input.policyClient.evaluate({
      actor: {
        type: "agent",
        id: input.persona.registryId,
        registryId: input.persona.registryId,
        department: input.persona.department,
      },
      action: "execute-run",
      resource: pc?.issueId
        ? {
            type: "ticket",
            id: pc.issueId,
            ticketIdentifier: input.ticketIdentifier,
            projectId: input.workspace?.projectName,
            workspaceCwd: input.workspace?.cwd,
          }
        : undefined,
      bucket: input.task as never,
    });
    if (verdict.decision === "deny") {
      process.stderr.write(
        `[policy] DENY ${input.persona.registryId} action=execute-run reason=${verdict.reason ?? "n/a"} rule=${verdict.matchedRule ?? "?"}\n`,
      );
      const durationMs = Date.now() - start;
      return {
        exitCode: 2,
        output: `**Policy denied:** ${verdict.reason ?? "no reason given"}${verdict.matchedRule ? ` (rule: ${verdict.matchedRule})` : ""}`,
        durationMs,
        mode: "direct-cli",
      };
    }
    if (verdict.decision === "require_approval") {
      process.stderr.write(
        `[policy] HOLD ${input.persona.registryId} reason=${verdict.reason ?? "n/a"} — posting awaiting-approval comment and aborting\n`,
      );
      // Mark the ticket as awaiting human go-ahead. The /approve endpoint
      // re-launches the run with approved=true to skip this gate.
      if (pc) {
        try {
          const reason = verdict.reason ?? "policy requires explicit approval";
          const rule = verdict.matchedRule ? ` (rule: ${verdict.matchedRule})` : "";
          await pc.client.postComment(
            pc.issueId,
            `**⏸ Awaiting approval**${rule}\n\n${reason}\n\nTo proceed, hit \`POST /approve { runId: "${input.runId ?? "<runId>"}" }\` on the bridge or have a board user re-launch this ticket.`,
          );
          await pc.client.updateStatus(pc.issueId, "blocked");
        } catch (e) {
          process.stderr.write(`[policy] failed to post approval marker: ${(e as Error).message}\n`);
        }
      }
      const durationMs = Date.now() - start;
      return {
        exitCode: 2,
        output: `**Awaiting approval:** ${verdict.reason ?? "policy requires explicit approval"}`,
        durationMs,
        mode: "direct-cli",
      };
    }
  }

  if (input.persona && candidates.length > 0) {
    const baseDirectPrompt = buildDirectCliPrompt({
      agentName: input.persona.agentName,
      registryId: input.persona.registryId,
      department: input.persona.department,
      rolePersonality: input.persona.systemPrompt,
      workspaceCwd: input.workspace?.cwd,
      workspaceName: input.workspace?.projectName,
      task: input.prompt,
    });
    const directPrompt = memoryBlock
      ? `${memoryBlock}\n\n---\n\n${baseDirectPrompt}`
      : baseDirectPrompt;

    // We track which (cli, model) pairs we've already spawned so the next
    // iteration excludes them from the pool sent to quota. Without this guard
    // we'd loop on the same failing provider forever.
    const attempted = new Set<string>();
    const maxAttempts = candidates.length + 2; // small slack for survival inserts

    while (attemptCount < maxAttempts) {
      const remaining = candidates.filter(
        (c) => !attempted.has(`${c.cli}|${c.model}`),
      );
      if (remaining.length === 0) break;

      reportStage("quota-select");
      // Ask quota for the best usable candidate from what's left. Quota
      // applies hard-rules + provider availability (incl. cooldowns) + survival
      // overlay. If it can't pick any, we're done.
      let chosen = remaining[0]!;
      let quotaReason = "preferred";
      if (input.quotaClient?.isEnabled()) {
        const select = await input.quotaClient
          .selectModel({
            role: input.persona.registryId,
            task: input.task,
            candidates: remaining,
          })
          .catch(() => null);
        if (!select) {
          // Quota couldn't find anything available among the remaining
          // candidates (e.g. all providers down or budget-exhausted). Stop.
          process.stderr.write(
            `[fallback] quota returned no usable candidate (${remaining.length} remaining) — stopping retry loop\n`,
          );
          break;
        }
        chosen = select.chosen;
        quotaReason = select.reason;
        // Quota may inject survivalModels (NOT in `remaining`) and pick one.
        // If that pick was already tried this run, we'd loop forever. Mark it
        // down so the next /select call skips it, and break out so we don't
        // re-spawn the same failing one.
        if (attempted.has(`${chosen.cli}|${chosen.model}`)) {
          if (input.quotaClient?.isEnabled()) {
            void input.quotaClient
              .markProviderDown(
                chosen.provider,
                AUTO_COOLDOWN_SEC,
                `auto: re-picked already-attempted ${chosen.cli}/${chosen.model}`,
              )
              .catch(() => {});
          }
          process.stderr.write(
            `[fallback] quota re-picked already-tried ${chosen.cli}/${chosen.model} — marking provider down + retrying\n`,
          );
          continue;
        }
      }

      attempted.add(`${chosen.cli}|${chosen.model}`);
      attemptCount++;

      const cli = asCli(chosen.cli);
      if (!cli) {
        process.stderr.write(
          `[fallback] attempt ${attemptCount}: cli=${chosen.cli} not supported by direct-cli — skipping\n`,
        );
        continue;
      }

      reportStage("cli-running", { cli: chosen.cli, model: chosen.model });
      const t0 = Date.now();
      const result = await invokeCli({
        cli,
        model: chosen.model,
        prompt: directPrompt,
        cwd: input.workspace?.cwd,
        onChunk: input.onOutput,
      });
      const attemptDuration = Date.now() - t0;

      process.stderr.write(
        `[fallback] attempt ${attemptCount}: ${chosen.cli}/${chosen.model}` +
          ` (${quotaReason})` +
          ` exit=${result.exitCode}` +
          `${result.costUsd !== undefined ? ` $${result.costUsd.toFixed(4)}` : ""}` +
          `${result.exitCode === 0 ? " — OK" : " — FAIL"}\n`,
      );

      // Remember the latest attempt — even on failure — so we have a result
      // to return if the entire chain fails.
      exitCode = result.exitCode;
      output = (result.parsedText ?? result.stdout).trim();
      stderr = result.stderr;
      effectiveCli = chosen.cli;
      effectiveModel = chosen.model;
      effectiveProvider = chosen.provider;
      costUsd = result.costUsd ?? 0;
      tokens = result.tokens;

      if (result.exitCode === 0) break;

      // Failure — record outcome to learning per attempt so dashboard sees the chain.
      if (input.learningClient?.isEnabled()) {
        void input.learningClient
          .recordOutcome({
            provider: chosen.provider,
            cli: chosen.cli,
            model: chosen.model,
            taskType: input.task ?? "other",
            success: false,
            durationMs: attemptDuration,
            costUsd: result.costUsd ?? 0,
            agentRegistryId: input.persona.registryId,
            ticketId: input.ticketIdentifier ?? pc?.issueId,
            failureReason: `attempt ${attemptCount}: exit ${result.exitCode}`,
          })
          .catch(() => {});
      }

      // Auto-cooldown: after N failures of the same provider in one run, ask
      // quota to mark it down for AUTO_COOLDOWN_SEC. Subsequent /select calls
      // (this run AND other concurrent runs) will skip it automatically.
      const failures = (failuresByProvider.get(chosen.provider) ?? 0) + 1;
      failuresByProvider.set(chosen.provider, failures);
      if (failures >= AUTO_COOLDOWN_FAIL_THRESHOLD && input.quotaClient?.isEnabled()) {
        void input.quotaClient
          .markProviderDown(
            chosen.provider,
            AUTO_COOLDOWN_SEC,
            `auto: ${failures} fails in single run for ${input.persona.registryId}`,
          )
          .catch(() => {});
        process.stderr.write(
          `[fallback] provider=${chosen.provider} marked DOWN ${AUTO_COOLDOWN_SEC}s after ${failures} consecutive fails\n`,
        );
      }
    }

    if (attemptCount === 0) {
      process.stderr.write(
        `[fallback] all ${candidates.length} candidates skipped — falling through to hermes oneshot\n`,
      );
    }
  }

  // Hermes fallback path:
  //  - no persona at all → hermes-oneshot raw
  //  - persona but candidates.length === 0 or every candidate was skipped → hermes-fallback
  //  - persona + at least one attempt was made but ALL failed → DON'T fall to hermes
  //    (we already exhausted options; surface the last failure)
  if (attemptCount === 0) {
    mode = input.persona ? "hermes-fallback" : "hermes-oneshot";
    const finalPrompt = input.persona
      ? buildPersonaPrompt(input.persona, input.prompt, input.workspace)
      : input.prompt;
    const result = await runHermesOneshotCaptured({
      prompt: finalPrompt,
      model: input.model,
      provider: input.provider,
      cwd: input.workspace?.cwd,
    });
    exitCode = result.exitCode;
    output = result.stdout.trim();
    stderr = result.stderr;
    // Hermes uses whatever provider it was configured with — best-effort attribution.
    if (!effectiveProvider) {
      effectiveCli = "hermes";
      effectiveModel = input.model;
      effectiveProvider = input.provider ?? inferProvider("hermes", input.model);
    }
  }

  const durationMs = Date.now() - start;

  // Quota record (R3 + R3.5): registramos uso real con cost/tokens parseados
  // del structured output del CLI. Si el CLI no emite cost (codex/agy o
  // parsing falla), cae a costUsd=0 y solo cuenta el request.
  if (input.quotaClient?.isEnabled() && effectiveProvider && effectiveCli) {
    void input.quotaClient
      .recordUsage({
        provider: effectiveProvider,
        cli: effectiveCli,
        costUsd,
        requests: 1,
        tokens,
        model: effectiveModel,
        agentRegistryId: input.persona?.registryId,
        ticketId: input.ticketIdentifier ?? pc?.issueId,
      })
      .catch((e) =>
        process.stderr.write(`[quota] recordUsage warn: ${(e as Error).message}\n`),
      );
  }

  // Learning outcome (R8): registramos el resultado de la corrida para que
  // el Quota Manager (en el futuro) consulte /best-for y elija providers segun
  // historico de success_rate × cost. Fire-and-forget — no bloquea el run.
  if (input.learningClient?.isEnabled() && effectiveProvider && effectiveCli && effectiveModel) {
    void input.learningClient
      .recordOutcome({
        provider: effectiveProvider,
        cli: effectiveCli,
        model: effectiveModel,
        taskType: input.task ?? "other",
        success: exitCode === 0,
        durationMs,
        costUsd,
        agentRegistryId: input.persona?.registryId,
        ticketId: input.ticketIdentifier ?? pc?.issueId,
        failureReason: exitCode !== 0 ? `exit ${exitCode}` : undefined,
      })
      .catch((e) =>
        process.stderr.write(`[learning] recordOutcome warn: ${(e as Error).message}\n`),
      );
  }

  // Memory store (L4 — 2 scopes paralelos):
  //   agent → individual run record (este worker en este ticket)
  //   project → SOLO si hay workspace, registra que sucedio en el proyecto
  // Company / Market se escriben aparte por roles especificos (research, strategy).
  if (exitCode === 0 && input.persona && pc) {
    const memText = [
      `Ticket: ${input.ticketIdentifier ?? pc.issueId}`,
      `Tarea original:`,
      input.prompt.slice(0, 1500),
      ``,
      `Mi resultado (${input.persona.agentName} via ${mode}):`,
      output.slice(0, 1500) || "(sin output)",
    ].join("\n");
    const stores: Promise<boolean>[] = [
      storeMemory({
        scope: "agent",
        registryId: input.persona.registryId,
        ticketId: pc.issueId,
        ticketIdentifier: input.ticketIdentifier,
        projectId: input.workspace?.projectName,
        text: memText,
      }),
    ];
    if (input.workspace) {
      stores.push(
        storeMemory({
          scope: "project",
          projectId: input.workspace.projectName,
          ticketId: pc.issueId,
          ticketIdentifier: input.ticketIdentifier,
          registryId: input.persona.registryId,
          text: memText,
          tags: [input.persona.department, input.persona.registryId],
        }),
      );
    }
    try {
      const results = await Promise.all(stores);
      const ok = results.filter(Boolean).length;
      process.stderr.write(
        `[memory] stored ${ok}/${results.length} scopes for ${input.persona.registryId} ticket=${input.ticketIdentifier ?? "?"}\n`,
      );
    } catch (e) {
      process.stderr.write(`[memory] store error: ${(e as Error).message}\n`);
    }
  }

  // Auto-commit en el workspace si la ejecucion fue OK + hay workspace + hubo cambios
  let commitInfo: CommitResult | null = null;
  if (exitCode === 0 && input.workspace && input.persona) {
    try {
      commitInfo = await autoCommitWorkspace(
        input.workspace,
        input.persona,
        input.ticketIdentifier ?? "task",
        input.ticketIdentifier,
      );
      process.stderr.write(
        `[auto-commit] persona=${input.persona.registryId} hadChanges=${commitInfo.hadChanges} committed=${commitInfo.committed} sha=${commitInfo.commitSha ?? "-"}${commitInfo.stderr ? " err=" + commitInfo.stderr.slice(0, 200) : ""}\n`,
      );
    } catch (e) {
      process.stderr.write(`auto-commit error: ${(e as Error).message}\n`);
    }
  }

  if (pc) {
    const finalStatus: "done" | "blocked" = exitCode === 0 ? "done" : "blocked";
    const personaTag = input.persona
      ? `\n\n_(${input.persona.agentName} via ${mode})_`
      : "";
    const commitTag = commitInfo?.committed
      ? `\n\n**Auto-commit**: \`${commitInfo.commitSha}\` (${input.workspace?.projectName})`
      : commitInfo?.attempted && !commitInfo.hadChanges
        ? `\n\n_(sin cambios en workspace, no commit)_`
        : "";
    const commentBody =
      exitCode === 0
        ? (output ||
            "(termino correctamente pero sin output. Verificar si genero archivos.)") +
          personaTag +
          commitTag
        : `**Ejecucion fallo** (exit ${exitCode}, mode=${mode})${personaTag}\n\n` +
          (output ? `\`\`\`\n${output.slice(0, 4000)}\n\`\`\`\n\n` : "") +
          (stderr.trim()
            ? `**stderr**\n\`\`\`\n${stderr.trim().slice(0, 4000)}\n\`\`\``
            : "");

    // Build presentation + metadata to signal "final report" semantics to
    // Paperclip's UI and (partly) its recovery system. Vendor schema valid:
    //   presentation: { kind: "message", tone: success|danger }
    //   metadata: { version: 1, sections: [...key_value rows...] }
    const presentation =
      exitCode === 0
        ? { kind: "message" as const, tone: "success" as const, title: "Final report — completed" }
        : { kind: "message" as const, tone: "danger" as const, title: "Final report — execution failed" };

    // Paperclip's strict schema: ONE key/value per row, label = key.
    const rows: Array<{ type: "key_value"; label: string; value: string }> = [];
    if (input.persona) rows.push({ type: "key_value", label: "agent", value: input.persona.agentName });
    rows.push({ type: "key_value", label: "mode", value: mode });
    if (effectiveCli) rows.push({ type: "key_value", label: "cli", value: effectiveCli });
    if (effectiveModel) rows.push({ type: "key_value", label: "model", value: effectiveModel });
    if (effectiveProvider) rows.push({ type: "key_value", label: "provider", value: effectiveProvider });
    rows.push({ type: "key_value", label: "exit_code", value: String(exitCode) });
    rows.push({ type: "key_value", label: "duration_ms", value: String(durationMs) });
    if (costUsd > 0) rows.push({ type: "key_value", label: "cost_usd", value: costUsd.toFixed(4) });
    if (tokens?.input) rows.push({ type: "key_value", label: "tokens_in", value: String(tokens.input) });
    if (tokens?.output) rows.push({ type: "key_value", label: "tokens_out", value: String(tokens.output) });
    rows.push({ type: "key_value", label: "disposition", value: exitCode === 0 ? "completed" : "failed" });
    rows.push({ type: "key_value", label: "next_action", value: "none" });
    if (commitInfo?.committed && commitInfo.commitSha) {
      rows.push({ type: "key_value", label: "commit_sha", value: commitInfo.commitSha });
    }

    const metadata = {
      version: 1 as const,
      sections: [
        {
          title: exitCode === 0 ? "Execution result" : "Execution failure",
          rows,
        },
      ],
    };

    // KNOWN VENDOR LIMITATION: Paperclip restricts `presentation` and
    // `metadata` fields to BOARD USERS ONLY (returns 403 for agent actors).
    // We keep the enriched payload code here for future use (e.g., when
    // running as a board-impersonating service or after vendor unlocks it),
    // but gate sending behind an env flag to avoid noisy 403s in normal
    // operation. The bridge falls back to plain body posts which always work.
    const enrichEnabled = process.env.PAPERCLIP_ENRICH_COMMENTS === "true";
    reportStage("posting-result");
    try {
      await pc.client.postComment(
        pc.issueId,
        commentBody,
        enrichEnabled ? { presentation, metadata } : undefined,
      );
    } catch (e) {
      process.stderr.write(`postComment warn: ${(e as Error).message}\n`);
    }
    try {
      await pc.client.updateStatus(pc.issueId, finalStatus);
    } catch (e) {
      process.stderr.write(
        `updateStatus(${finalStatus}) warn: ${(e as Error).message}\n`,
      );
    }
    void pc.client.reportCost(pc.issueId, {});
  }

  return { exitCode, output, durationMs, mode };
}
