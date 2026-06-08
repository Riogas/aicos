import { spawn } from "node:child_process";

export type SupportedCli = "claude" | "codex" | "agy" | "opencode" | "hermes";

export interface CliInvocationOptions {
  cli: SupportedCli;
  model?: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface CliInvocationResult {
  exitCode: number;
  /** Raw stdout (parser falls back to this if JSON parsing fails). */
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
  /** Cleaned-up final text (parsed from structured output). Falls back to stdout when parsing fails. */
  parsedText?: string;
  /** Cost in USD parsed from the CLI's structured output. undefined when CLI doesn't emit cost. */
  costUsd?: number;
  /** Token usage parsed from CLI output. */
  tokens?: { input?: number; output?: number; cached?: number };
}

function buildArgs(opts: CliInvocationOptions): string[] {
  switch (opts.cli) {
    case "claude":
      // --output-format json: single JSON object al final con {result, total_cost_usd, usage}
      return [
        "-p",
        opts.prompt,
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
      ];
    case "codex": {
      // -s workspace-write: permite editar archivos en el cwd sin pedir aprobacion.
      // --json: JSONL events stream (cada event en una linea)
      const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "--json"];
      if (opts.cwd) args.push("--cd", opts.cwd);
      args.push(opts.prompt);
      return args;
    }
    case "agy":
      return ["-p", opts.prompt, "--dangerously-skip-permissions"];
    case "opencode": {
      // --format json: NDJSON events (step_finish trae part.cost segun F10 e2e)
      const args = ["run", "--format", "json"];
      if (opts.model) args.push("-m", opts.model);
      args.push(opts.prompt);
      return args;
    }
    case "hermes": {
      // L1 integration (R5 spec): Hermes-Nous as brain. -z mode emits only the
      // final text. opts.model is "provider/model" (e.g. "openai/gpt-5.5"); if
      // present, split into -m / --provider.
      const args = ["-z", opts.prompt, "--yolo"];
      if (opts.model) {
        const slash = opts.model.indexOf("/");
        if (slash > 0) {
          args.push("--provider", opts.model.slice(0, slash));
          args.push("-m", opts.model.slice(slash + 1));
        } else {
          args.push("-m", opts.model);
        }
      }
      return args;
    }
  }
}

/**
 * Parsea la salida de cada CLI para extraer texto + costo + tokens.
 * Si la salida no es JSON valido (CLI cambio formato, error temprano, etc.),
 * devuelve {parsedText: undefined} para que el caller use stdout crudo.
 */
function parseOutput(
  cli: SupportedCli,
  stdout: string,
): Pick<CliInvocationResult, "parsedText" | "costUsd" | "tokens"> {
  if (!stdout.trim()) return {};
  try {
    switch (cli) {
      case "claude":
        return parseClaudeJson(stdout);
      case "codex":
        return parseCodexJsonl(stdout);
      case "opencode":
        return parseOpencodeNdjson(stdout);
      case "hermes":
        // -z mode emits ONLY the final response text. No cost in output —
        // request count is the meaningful unit for hermes routing.
        return { parsedText: stdout.trim() };
      case "agy":
        return {};
    }
  } catch (e) {
    process.stderr.write(`[parse:${cli}] fail: ${(e as Error).message}\n`);
    return {};
  }
}

/**
 * Claude `--output-format json`: emite UN solo JSON object con:
 *   { type: "result", subtype: "success", result: "...text...",
 *     total_cost_usd: 0.034, usage: { input_tokens, output_tokens, cache_*: ... } }
 */
function parseClaudeJson(
  stdout: string,
): Pick<CliInvocationResult, "parsedText" | "costUsd" | "tokens"> {
  const trimmed = stdout.trim();
  // Claude --output-format json emite UN objeto JSON. Puede haber prelude
  // (logs, etc.) antes — buscamos el primer "{" y parseamos desde ahi al final.
  const jsonStart = trimmed.indexOf("{");
  const candidate = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  const obj = JSON.parse(candidate) as {
    result?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  return {
    parsedText: obj.result?.trim() ?? undefined,
    costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
    tokens: obj.usage
      ? {
          input: obj.usage.input_tokens,
          output: obj.usage.output_tokens,
          cached: obj.usage.cache_read_input_tokens,
        }
      : undefined,
  };
}

/**
 * Codex `--json`: JSONL events. El ultimo event tipo "task_complete" o
 * "agent_message" final trae el texto. Eventos de "token_count" / "info"
 * agregan usage. NO emite costo por default — best-effort cero.
 */
function parseCodexJsonl(
  stdout: string,
): Pick<CliInvocationResult, "parsedText" | "costUsd" | "tokens"> {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  let lastText = "";
  let input = 0;
  let output = 0;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = ev["msg"] as Record<string, unknown> | undefined;
    const type = (ev["type"] as string) ?? (msg?.["type"] as string) ?? "";
    if (type === "agent_message" || type === "task_complete") {
      const text = (msg?.["message"] as string) ?? (ev["message"] as string) ?? "";
      if (text) lastText = text;
    }
    if (type === "token_count" || type === "usage") {
      input += Number(msg?.["input_tokens"] ?? ev["input_tokens"] ?? 0);
      output += Number(msg?.["output_tokens"] ?? ev["output_tokens"] ?? 0);
    }
  }
  return {
    parsedText: lastText || undefined,
    costUsd: undefined, // codex no emite cost; bridge usara 0
    tokens: input || output ? { input, output } : undefined,
  };
}

/**
 * Opencode `--format json`: NDJSON con events. Segun F10 e2e:
 *   - `step_finish` event trae `part.cost` (USD) y `part.tokens.{input,output,total}`
 *   - `text` events tienen `text` con el output del agente
 */
function parseOpencodeNdjson(
  stdout: string,
): Pick<CliInvocationResult, "parsedText" | "costUsd" | "tokens"> {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  let textBuf = "";
  let totalCost = 0;
  let input = 0;
  let output = 0;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (ev["type"] as string) ?? "";
    if (type === "step_finish" || type === "message.completed") {
      const part = ev["part"] as Record<string, unknown> | undefined;
      const cost = part?.["cost"] ?? ev["cost"];
      if (typeof cost === "number") totalCost += cost;
      const toks = (part?.["tokens"] ?? ev["tokens"]) as
        | { input?: number; output?: number }
        | undefined;
      if (toks) {
        input += Number(toks.input ?? 0);
        output += Number(toks.output ?? 0);
      }
    }
    if (type === "text" || type === "message" || type === "assistant") {
      const t = (ev["text"] as string) ?? (ev["content"] as string) ?? "";
      if (t) textBuf += t;
    }
  }
  return {
    parsedText: textBuf.trim() || undefined,
    costUsd: totalCost > 0 ? totalCost : undefined,
    tokens: input || output ? { input, output } : undefined,
  };
}

/**
 * Invoca una CLI agentic directamente (sin pasar por Hermes brain) y captura
 * stdout/stderr. Cada CLI ejecuta por su cuenta sus tools internos (edit files,
 * bash, etc.) — confiamos en su comportamiento agentic nativo.
 */
export function invokeCli(opts: CliInvocationOptions): Promise<CliInvocationResult> {
  const args = buildArgs(opts);
  const command = `${opts.cli} ${args.slice(0, args.length - 1).join(" ")} "<prompt:${opts.prompt.length}chars>"`;
  const start = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(opts.cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 600_000, // 10 min default
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      const exitCode = err.code === "ENOENT" ? 127 : 1;
      resolve({
        exitCode,
        stdout,
        stderr: `${stderr}\nspawn err (${opts.cli}): ${err.message}`,
        durationMs: Date.now() - start,
        command,
      });
    });

    proc.on("exit", (code, signal) => {
      const exitCode = signal ? 1 : code ?? 1;
      const parsed = exitCode === 0 ? parseOutput(opts.cli, stdout) : {};
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        command,
        ...parsed,
      });
    });
  });
}

/**
 * Construye el prompt para la CLI directa. Mas conciso que el persona prompt
 * de Hermes — las CLIs (claude/codex/agy/opencode) son agentes nativos de coding,
 * solo necesitan contexto del rol + workspace + tarea.
 */
export function buildDirectCliPrompt(opts: {
  agentName: string;
  registryId: string;
  department: string;
  rolePersonality: string;
  workspaceCwd?: string;
  workspaceName?: string;
  task: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `Eres ${opts.agentName} en el sistema AICOS (rol ${opts.registryId}, dept ${opts.department}).`,
  );
  lines.push(opts.rolePersonality);
  lines.push("");
  if (opts.workspaceCwd) {
    lines.push(`# Working directory`);
    lines.push(
      `Estas trabajando en \`${opts.workspaceCwd}\` (proyecto ${opts.workspaceName ?? "?"}).`,
    );
    lines.push(`Todos los archivos se crean / modifican EN ese directorio.`);
    lines.push("");
  }
  lines.push(`# Tarea`);
  lines.push(opts.task.trim());
  lines.push("");
  lines.push(`# Reglas`);
  lines.push(`- Ejecuta de verdad: crea archivos, edita codigo, corre comandos.`);
  lines.push(
    `- Sigue best practices actuales (Next.js 14 App Router cuando aplique, TypeScript, etc).`,
  );
  lines.push(`- Al terminar, haz commit con un mensaje claro.`);
  lines.push(`- NO pushees a remoto.`);
  lines.push(`- Al final, reporta brevemente: archivos creados/modificados + un summary 1-2 lineas.`);
  return lines.join("\n");
}

/**
 * Internal parsers exported under __testHooks for unit tests only.
 * NOT part of the public API — names may change without notice.
 */
export const __testHooks = {
  parseClaudeJson,
  parseCodexJsonl,
  parseOpencodeNdjson,
  parseOutput,
} as const;
