/**
 * POST /api/control/ticket { issueId, action }
 *   - "reject"   → cancela el ticket (status cancelled)
 *   - "relaunch" → libera el lock + lo manda a 'todo' (Paperclip lo re-despacha)
 */
import { pc } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { issueId?: string; action?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const { issueId, action } = body;
  if (!issueId || !action) return Response.json({ error: "falta issueId/action" }, { status: 400 });

  if (action === "reject") {
    const { code, data } = await pc("PATCH", `/api/issues/${issueId}`, { status: "cancelled" });
    return code < 300 ? Response.json({ ok: true }) : Response.json({ error: data?.error || `HTTP ${code}` }, { status: 502 });
  }

  if (action === "relaunch") {
    // Liberar cualquier lock de ejecución previo (best-effort) y mandar a todo.
    await pc("POST", `/api/issues/${issueId}/release`, {}).catch(() => {});
    const { code, data } = await pc("PATCH", `/api/issues/${issueId}`, { status: "todo" });
    return code < 300 ? Response.json({ ok: true }) : Response.json({ error: data?.error || `HTTP ${code}` }, { status: 502 });
  }

  return Response.json({ error: "action inválida" }, { status: 400 });
}
