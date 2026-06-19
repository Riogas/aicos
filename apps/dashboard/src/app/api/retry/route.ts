/**
 * GET    /api/retry          → { config, pending, escalated }
 * POST   /api/retry          → guarda config { enabled, maxAttempts, backoffMinutes }
 * DELETE /api/retry?issueId= → limpia el estado de retry/escalado de un ticket
 */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [cfg, st] = await Promise.all([
    bridge("GET", "/retry/config").catch(() => ({ code: 0, data: null })),
    bridge("GET", "/retry/state").catch(() => ({ code: 0, data: null })),
  ]);
  return Response.json({
    config: cfg.data?.config ?? { enabled: true, maxAttempts: 3, backoffMinutes: [2, 10, 30] },
    pending: st.data?.pending ?? [],
    escalated: st.data?.escalated ?? [],
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const { code, data } = await bridge("POST", "/retry/config", body);
  return Response.json(data ?? { error: "bridge no respondió" }, { status: code || 502 });
}

export async function DELETE(req: Request) {
  const issueId = new URL(req.url).searchParams.get("issueId");
  if (!issueId) return Response.json({ error: "falta issueId" }, { status: 400 });
  const { code, data } = await bridge("DELETE", `/retry/${encodeURIComponent(issueId)}`);
  return Response.json(data ?? { ok: false }, { status: code || 502 });
}
