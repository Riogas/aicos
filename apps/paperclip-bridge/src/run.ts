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

  // Estrategia de ejecucion:
  //   1) Si hay persona + CLI conocida: spawnear esa CLI DIRECTAMENTE
  //      (Hermes brain saltea — la CLI es agente nativo y ejecuta tools por su cuenta).
  //   2) Si hay persona pero CLI desconocida: cae a Hermes oneshot con persona prompt.
  //   3) Si no hay persona: Hermes oneshot crudo (CLI mode tradicional del bridge).
  //
  // Quota-aware override (R3): si quotaClient esta presente + hay persona, consultamos
  // /select antes del spawn. El Quota Manager elige preferred/fallback/survival segun
  // budgets reales. Si responde null (caido o pass-through) usamos el preferred del registry.
  let effectiveCli = input.persona?.preferredModel?.cli;
  let effectiveModel = input.persona?.preferredModel?.model;
  let effectiveProvider: string | undefined;
  let quotaReason: string | undefined;

  if (input.quotaClient?.isEnabled() && input.persona) {
    const candidates = buildCandidates(
      input.persona.preferredModel,
      input.persona.fallbackChain,
    );
    if (candidates.length > 0) {
      const result = await input.quotaClient.selectModel({
        role: input.persona.registryId,
        task: input.task,
        candidates,
      });
      if (result) {
        effectiveCli = result.chosen.cli;
        effectiveModel = result.chosen.model;
        effectiveProvider = result.chosen.provider;
        quotaReason = result.reason;
        if (result.reason !== "preferred") {
          process.stderr.write(
            `[quota] persona=${input.persona.registryId} routed to ${result.chosen.cli}/${result.chosen.model} (${result.reason}${result.survivalActive ? ", survival" : ""})\n`,
          );
        }
      }
    }
  }
  if (!effectiveProvider && effectiveCli) {
    effectiveProvider = inferProvider(effectiveCli, effectiveModel);
  }

  const cli = asCli(effectiveCli);

  let exitCode: number;
  let output: string;
  let stderr: string;
  let mode: ExecuteRunResult["mode"];
  let costUsd = 0;
  let tokens: { input?: number; output?: number; cached?: number } | undefined;

  // Memory retrieval (L4 — 4 scopes): agent (este worker), project (workspace),
  // company + market (global). Inyectados como contexto al prompt.
  let memoryBlock = "";
  if (input.persona) {
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

  if (input.persona && cli) {
    mode = "direct-cli";
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
    const result = await invokeCli({
      cli,
      model: effectiveModel,
      prompt: directPrompt,
      cwd: input.workspace?.cwd,
    });
    exitCode = result.exitCode;
    // Preferimos parsedText (texto limpio del CLI structured output) sobre stdout crudo.
    output = (result.parsedText ?? result.stdout).trim();
    stderr = result.stderr;
    if (result.costUsd !== undefined) costUsd = result.costUsd;
    if (result.tokens) tokens = result.tokens;
    process.stderr.write(
      `[direct-cli ${cli}${quotaReason ? ` ${quotaReason}` : ""}${result.costUsd !== undefined ? ` $${result.costUsd.toFixed(4)}` : ""}] ${result.command}\n`,
    );
  } else {
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

    try {
      await pc.client.postComment(pc.issueId, commentBody);
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
