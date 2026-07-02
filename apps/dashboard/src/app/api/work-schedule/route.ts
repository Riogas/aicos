/**
 * GET  /api/work-schedule  → { config, status }
 * POST /api/work-schedule  → guarda { enabled, timezone, days }
 */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [cfg, st] = await Promise.all([
    bridge("GET", "/work-schedule/config").catch(() => ({ code: 0, data: null })),
    bridge("GET", "/work-schedule/status").catch(() => ({ code: 0, data: null })),
  ]);
  return Response.json({
    config: cfg.data?.config ?? null,
    status: st.data ?? null,
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const { code, data } = await bridge("POST", "/work-schedule/config", body);
  return Response.json(data ?? { error: "bridge no respondió" }, { status: code || 502 });
}
