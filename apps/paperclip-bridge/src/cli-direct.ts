import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type SupportedCli = "claude" | "codex" | "agy" | "opencode" | "hermes";

const SUPPORTED_CLIS: readonly SupportedCli[] = ["claude", "codex", "agy", "opencode", "hermes"];

// Config de MCP (conectores/tools) en formato Claude Code, generada por el
// dashboard (apartado MCP). Si existe, claude la carga.
const MCP_CONFIG = process.env.AICOS_MCP_CONFIG || join(process.env.HOME || "/home/vagrant", ".config", "aicos", "claude-mcp.json");

/** Nombre del binario en disco para cada CLI (hoy 1:1 con el id). */
const CLI_BINARY: Record<SupportedCli, string> = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
  opencode: "opencode",
  hermes: "hermes",
};

function binaryOnPath(bin: string): boolean {
  const PATH = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, bin + ext))) return true;
    }
  }
  return false;
}

const availabilityCache = new Map<string, boolean>();

/**
 * ¿Esta CLI es usable (instalada Y habilitada/configurada) en este entorno?
 *
 * El retry-chain (preferredModel + fallbackChain) se filtra con esto ANTES de
 * intentar spawnear, con dos gates:
 *
 *  1. ALLOWLIST — `AICOS_ENABLED_CLIS` (CSV, ej. "claude" o "claude,codex").
 *     Si está seteada, SOLO esas CLIs se consideran configuradas; el resto se
 *     descarta aunque su binario esté presente. Esto es clave en Path A: la
 *     imagen de Paperclip trae claude/codex/opencode instalados, pero solo el
 *     que el operador autenticó debe usarse — si no, el chain "caería" a un CLI
 *     instalado-pero-sin-credenciales y fallaría por auth. En un entorno
 *     solo-Claude se setea `AICOS_ENABLED_CLIS=claude` y el chain nunca intenta
 *     codex/opencode. Sin la var (no seteada), no hay allowlist y se cae al
 *     gate 2 solo (compat hacia atrás).
 *
 *  2. BINARIO EN PATH — descarta CLIs no instaladas (evita ENOENT). agy/hermes
 *     no están en la imagen de Paperclip, así que se saltean por acá.
 *
 * Cacheado por proceso el gate 2 (el PATH no cambia durante un run; y cada run
 * en modo process-adapter es un proceso nuevo, así que recoge cambios igual).
 * El allowlist se relee siempre (es barato y permite override por run via env).
 */
export function isCliAvailable(cli: string): boolean {
  if (!SUPPORTED_CLIS.includes(cli as SupportedCli)) return false;
  const c = cli as SupportedCli;
  // Gate 1: allowlist explícita de CLIs habilitadas/configuradas.
  const allow = (process.env.AICOS_ENABLED_CLIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length > 0 && !allow.includes(c)) return false;
  // Gate 2: binario resoluble en PATH (cacheado).
  const cached = availabilityCache.get(c);
  if (cached !== undefined) return cached;
  const ok = binaryOnPath(CLI_BINARY[c]);
  availabilityCache.set(c, ok);
  return ok;
}

/** A live chunk of agent output streamed while the CLI runs. */
export interface StreamChunk {
  kind: "text" | "tool" | "thinking";
  text: string;
}

export interface CliInvocationOptions {
  cli: SupportedCli;
  model?: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Called for each parsed output chunk as the CLI streams it (claude/codex/
   * opencode emit NDJSON events). Best-effort live view — never blocks the run.
   */
  onChunk?: (chunk: StreamChunk) => void;
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

/**
 * Mapea el nombre de modelo del registry al id/alias que entiende `claude --model`.
 * El CLI acepta alias de familia ("sonnet"/"opus"/"haiku") y resuelve al ultimo
 * de esa familia — mas robusto que pasar un id exacto que puede no existir.
 */
function claudeModelAlias(model: string | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null; // desconocido → dejar que claude use su default
}

function buildArgs(opts: CliInvocationOptions): string[] {
  switch (opts.cli) {
    case "claude": {
      // --output-format stream-json: NDJSON, un event por linea (system/assistant/
      // user/result). Permite streamear el output en vivo Y el ultimo event
      // `result` trae {result, total_cost_usd, usage}. Requiere --verbose en -p.
      const args = [
        "-p",
        opts.prompt,
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      const alias = claudeModelAlias(opts.model);
      if (alias) args.push("--model", alias);
      if (existsSync(MCP_CONFIG)) args.push("--mcp-config", MCP_CONFIG);
      return args;
    }
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

function briefToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description;
  if (typeof pick === "string") return pick.slice(0, 100);
  return JSON.stringify(o).slice(0, 90);
}

/**
 * Extrae chunks de output en vivo de UNA linea NDJSON, por CLI. Devuelve []
 * si la linea no aporta texto/tool visible. Tolerante a basura (no-JSON → []).
 */
export function extractStreamChunks(cli: SupportedCli, line: string): StreamChunk[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return [];
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: StreamChunk[] = [];
  if (cli === "claude") {
    // assistant event: message.content = [{type:text|thinking|tool_use, ...}]
    if (ev.type === "assistant") {
      const msg = ev.message as { content?: unknown[] } | undefined;
      for (const p of msg?.content ?? []) {
        const part = p as Record<string, unknown>;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          out.push({ kind: "text", text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string") {
          out.push({ kind: "thinking", text: part.thinking });
        } else if (part.type === "tool_use") {
          out.push({ kind: "tool", text: `${String(part.name ?? "tool")} ${briefToolInput(part.input)}`.trim() });
        }
      }
    }
  } else if (cli === "codex") {
    const msg = (ev.msg as Record<string, unknown>) ?? ev;
    const type = (ev.type as string) ?? (msg.type as string) ?? "";
    if (type === "agent_message") {
      const t = (msg.message as string) ?? (ev.message as string) ?? "";
      if (t.trim()) out.push({ kind: "text", text: t });
    } else if (type === "agent_reasoning") {
      const t = (msg.text as string) ?? (ev.text as string) ?? "";
      if (t.trim()) out.push({ kind: "thinking", text: t });
    } else if (type === "exec_command_begin" || type === "tool_call") {
      const cmd = (msg.command as string) ?? JSON.stringify(msg).slice(0, 100);
      out.push({ kind: "tool", text: String(cmd) });
    }
  } else if (cli === "opencode") {
    if ((ev.type === "text" || ev.type === "assistant" || ev.type === "message") &&
        (ev.text || ev.content)) {
      const t = (ev.text as string) ?? (ev.content as string) ?? "";
      if (t.trim()) out.push({ kind: "text", text: t });
    }
  }
  return out;
}

/**
 * Claude `--output-format stream-json`: NDJSON. El ultimo event `result` trae
 *   { type:"result", subtype:"success", result:"...text...",
 *     total_cost_usd: 0.034, usage:{input_tokens, output_tokens, cache_*} }
 * Backward-compat: si recibe el formato viejo (UN solo objeto json) tambien lo
 * parsea.
 */
function parseClaudeJson(
  stdout: string,
): Pick<CliInvocationResult, "parsedText" | "costUsd" | "tokens"> {
  const trimmed = stdout.trim();
  type ResultObj = {
    type?: string;
    result?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  let obj: ResultObj | null = null;
  // stream-json: buscar la linea con type==="result" (de atras hacia adelante).
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  if (lines.length > 1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]) as ResultObj;
        if (o && o.type === "result") {
          obj = o;
          break;
        }
      } catch {
        /* skip malformed line */
      }
    }
  }
  // Fallback: formato json clasico (UN objeto, posible prelude antes del primer "{").
  if (!obj) {
    const jsonStart = trimmed.indexOf("{");
    const candidate = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
    obj = JSON.parse(candidate) as ResultObj;
  }
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
      // El bridge corre como root dentro del container de Paperclip y spawnea
      // claude con --dangerously-skip-permissions; claude lo rechaza como root
      // salvo que IS_SANDBOX declare un entorno sandboxeado. Paperclip no
      // siempre propaga esta env al adapter, así que la garantizamos acá (el
      // container ES un sandbox aislado). No pisa un valor ya seteado.
      env: { ...process.env, IS_SANDBOX: process.env.IS_SANDBOX ?? "1" },
    });

    let stdout = "";
    let stderr = "";
    let lineBuf = ""; // para emitir chunks por linea NDJSON en vivo

    proc.stdout.on("data", (c: Buffer) => {
      const s = c.toString("utf-8");
      stdout += s;
      if (!opts.onChunk) return;
      // Stream live: parsear cada linea completa apenas llega.
      lineBuf += s;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        for (const chunk of extractStreamChunks(opts.cli, line)) {
          try {
            opts.onChunk(chunk);
          } catch {
            /* el live view nunca rompe el run */
          }
        }
      }
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
