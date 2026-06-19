/**
 * GET /api/run-transcript?ticket=RIO-X — transcript COMPLETO del último run del
 * ticket: baja el log NDJSON del heartbeat-run y lo parsea a entradas legibles
 * (texto del agente, tools que usó, razonamiento, logs del sistema).
 */
import { pc, PAPERCLIP, PC_TOKEN, COMPANY } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Entry { kind: "text" | "tool" | "thinking" | "system" | "result"; text: string }

function parseClaudeEvents(stdout: string, out: Entry[]) {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant") {
      for (const p of ev.message?.content ?? []) {
        if (p.type === "text" && p.text?.trim()) out.push({ kind: "text", text: p.text });
        else if (p.type === "thinking" && p.thinking?.trim()) out.push({ kind: "thinking", text: p.thinking });
        else if (p.type === "tool_use") {
          const inp = p.input?.command || p.input?.file_path || p.input?.path || p.input?.pattern || p.input?.description || "";
          out.push({ kind: "tool", text: `${p.name ?? "tool"}${inp ? `: ${String(inp).slice(0, 160)}` : ""}` });
        }
      }
    } else if (ev.type === "result" && typeof ev.result === "string") {
      out.push({ kind: "result", text: ev.result });
    }
  }
}

export async function GET(req: Request) {
  const ticket = new URL(req.url).searchParams.get("ticket")?.trim();
  if (!ticket) return Response.json({ error: "falta ?ticket=" }, { status: 400 });

  // 1) ticket → issue id
  const issue = await pc("GET", `/api/issues/${encodeURIComponent(ticket)}`);
  const issueId = issue.code === 200 ? issue.data?.id : null;
  if (!issueId) return Response.json({ error: `no encontré el ticket ${ticket}` }, { status: 404 });

  // 2) heartbeat-runs del issue con log
  const { code, data } = await pc("GET", `/api/companies/${COMPANY}/heartbeat-runs?limit=300`);
  if (code !== 200) return Response.json({ error: "no pude listar runs" }, { status: 502 });
  const runs = (Array.isArray(data) ? data : data.items ?? data.runs ?? [])
    .filter((r: any) => (r.contextSnapshot?.issueId === issueId) && (r.logBytes || 0) > 0)
    .sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  if (!runs.length) return Response.json({ error: "ese ticket no tiene runs con transcript todavía" }, { status: 404 });
  const run = runs[0];

  // 3) bajar el log NDJSON (raw text)
  const logRes = await fetch(`${PAPERCLIP}/api/heartbeat-runs/${run.id}/log`, {
    headers: { Authorization: `Bearer ${PC_TOKEN}` },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!logRes.ok) return Response.json({ error: `log no disponible (HTTP ${logRes.status})` }, { status: 502 });
  // El endpoint devuelve { runId, store, logRef, content } — content es el NDJSON.
  const logWrap = (await logRes.json().catch(() => null)) as { content?: string } | null;
  const logText = logWrap?.content ?? "";

  // 4) parsear NDJSON {ts, stream, chunk}
  const stdoutBuf: string[] = [];
  const entries: Entry[] = [];
  for (const raw of logText.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const chunk: string = rec.chunk ?? "";
    if (rec.stream === "stderr") {
      for (const s of chunk.split("\n")) if (s.trim()) entries.push({ kind: "system", text: s.trim() });
    } else {
      stdoutBuf.push(chunk);
    }
  }
  parseClaudeEvents(stdoutBuf.join(""), entries);

  return Response.json({
    ok: true,
    runId: run.id,
    status: run.status,
    exitCode: run.exitCode,
    entries,
  });
}
