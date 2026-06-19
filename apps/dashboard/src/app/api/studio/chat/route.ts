/**
 * POST /api/studio/chat — sesión conversacional de la Strategy Room.
 *
 * Corre `claude` DENTRO del container aicos-paperclip (donde está instalado y
 * autenticado, como uid 1000 con el home del host montado), en streaming. Usa
 * session-resume de claude para mantener el hilo: el primer turno crea la sesión
 * (devolvemos su sessionId), los siguientes la continúan con --resume.
 *
 * Body: { interlocutor: "hermes"|"ceo", message: string, sessionId?: string, model?: "opus"|"sonnet" }
 * Respuesta: stream NDJSON, una línea por evento:
 *   {"type":"session","sessionId":"..."}   (una vez, primer turno)
 *   {"type":"text","text":"..."}            (chunks del agente)
 *   {"type":"done","costUsd":n}             (al cerrar)
 *   {"type":"error","error":"..."}
 */
import { spawn } from "node:child_process";
import { buildSystemPrompt, loadRoster, type Interlocutor } from "@/lib/studio-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTAINER = process.env.AICOS_AGENT_CONTAINER || "aicos-paperclip";
const AGENT_UID = process.env.AICOS_AGENT_UID || "1000:1000";
const HOST_HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const REPO = process.env.AICOS_ROOT || `${HOST_HOME}/aicos`;
const CAN_READ_REPO = process.env.STUDIO_REPO_ACCESS !== "0"; // default ON

function modelAlias(m: string | undefined): string {
  const s = (m || "").toLowerCase();
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return "opus"; // default: specs de calidad
}

const BRIDGE = process.env.BRIDGE_SERVICE_URL || "http://localhost:7100";

/**
 * Trae contexto de charlas anteriores desde la memoria L4 (Qdrant vía bridge),
 * scope "company". Se inyecta en el system prompt al iniciar una conversación
 * nueva para que el agente tenga continuidad entre días/temas.
 */
async function retrieveMemoryContext(query: string): Promise<string> {
  try {
    const res = await fetch(`${BRIDGE}/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, scope: "company", limit: 5 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return "";
    const d = (await res.json()) as { items?: { text?: string; summary?: string }[] };
    const items = (d.items || [])
      .map((it) => (it.summary || it.text || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5);
    if (!items.length) return "";
    return (
      "\n\n# Memoria de charlas anteriores (contexto recuperado — usalo si es relevante, ignoralo si no)\n" +
      items.map((t) => `- ${t.slice(0, 400)}`).join("\n")
    );
  } catch {
    return "";
  }
}

/** Persiste el intercambio en la memoria L4 (scope company) — fire-and-forget. */
function storeStrategyMemory(who: string, userMsg: string, agentText: string): void {
  const text =
    `Strategy Room (${who === "ceo" ? "CEO" : "Hermes"}). ` +
    `El operador planteó: ${userMsg.slice(0, 500)}\n` +
    `Respuesta/acuerdo: ${agentText.replace(/\s+/g, " ").slice(0, 900)}`;
  try {
    void fetch(`${BRIDGE}/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "company",
        text,
        summary: userMsg.slice(0, 140),
        tags: ["strategy-room", who],
      }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  } catch { /* noop */ }
}

export async function POST(req: Request) {
  let body: { interlocutor?: string; message?: string; sessionId?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid body" }), { status: 400 });
  }
  const who = (body.interlocutor === "ceo" ? "ceo" : "hermes") as Interlocutor;
  const message = (body.message || "").trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "missing message" }), { status: 400 });
  }
  const sessionId = body.sessionId?.trim();

  const args = [
    "exec", "-i",
    "-u", AGENT_UID,
    "-e", `HOME=${HOST_HOME}`,
    "-e", "IS_SANDBOX=1",
    "-w", CAN_READ_REPO ? REPO : HOST_HOME,
    CONTAINER,
    "claude", "-p", message,
    "--output-format", "stream-json",
    "--verbose",
    "--model", modelAlias(body.model),
    "--dangerously-skip-permissions",
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  } else {
    const roster = loadRoster();
    const memCtx = await retrieveMemoryContext(message);
    args.push("--append-system-prompt", buildSystemPrompt(who, roster, CAN_READ_REPO) + memCtx);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      let stderr = "";
      let sentSession = false;
      let assistantText = "";
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { /* closed */ }
      };

      proc.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line[0] !== "{") continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line); } catch { continue; }
          // init → session id
          if (ev.type === "system" && ev.subtype === "init" && !sentSession) {
            const sid = ev.session_id as string | undefined;
            if (sid) { send({ type: "session", sessionId: sid }); sentSession = true; }
          }
          // assistant → texto en vivo
          if (ev.type === "assistant") {
            const msg = ev.message as { content?: unknown[] } | undefined;
            for (const p of msg?.content ?? []) {
              const part = p as Record<string, unknown>;
              if (part.type === "text" && typeof part.text === "string" && part.text) {
                assistantText += part.text;
                send({ type: "text", text: part.text });
              } else if (part.type === "tool_use") {
                send({ type: "tool", text: String(part.name ?? "tool") });
              }
            }
          }
          // result → fin + costo
          if (ev.type === "result") {
            send({ type: "done", costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0 });
          }
        }
      });
      proc.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      proc.on("error", (e) => { send({ type: "error", error: `spawn docker: ${e.message}` }); try { controller.close(); } catch {} });
      proc.on("exit", (code) => {
        if (code !== 0) {
          send({ type: "error", error: `claude exit ${code}: ${stderr.slice(-400) || "sin stderr"}` });
        } else if (assistantText.trim()) {
          // Persistir el intercambio como memoria L4 (continuidad entre charlas).
          storeStrategyMemory(who, message, assistantText);
        }
        try { controller.close(); } catch {}
      });
      // Si el cliente corta, matamos el proceso.
      req.signal?.addEventListener?.("abort", () => { try { proc.kill("SIGTERM"); } catch {} });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
