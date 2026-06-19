/**
 * POST /api/control/panic { action: "pause"|"resume" }
 *   pause  → pausa TODOS los agentes (Paperclip deja de despacharles) + cancela
 *            los runs en vuelo.
 *   resume → reanuda todos los agentes.
 */
import { listAgents, pc, bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let action: string | undefined;
  try { action = (await req.json())?.action; } catch { /* */ }
  if (action !== "pause" && action !== "resume") {
    return Response.json({ error: "action debe ser pause|resume" }, { status: 400 });
  }
  const agents = await listAgents();
  if (!agents.length) return Response.json({ error: "no pude listar agentes" }, { status: 502 });

  let affected = 0;
  await Promise.all(agents.map(async (a) => {
    const r = await pc("POST", `/api/agents/${a.id}/${action}`, {}).catch(() => ({ code: 0 }));
    if (r.code >= 200 && r.code < 300) affected++;
  }));

  let cancelled = 0;
  if (action === "pause") {
    const inflight = await bridge("GET", "/in-flight").then((r) => r.data).catch(() => null);
    for (const item of inflight?.items ?? []) {
      const runId = item.runId || item.id;
      if (!runId) continue;
      const r = await bridge("DELETE", `/run/${runId}?reason=panic-pause`).catch(() => ({ code: 0 }));
      if (r.code >= 200 && r.code < 300) cancelled++;
    }
  }

  return Response.json({ ok: true, action, affected, totalAgents: agents.length, cancelledRuns: cancelled });
}
