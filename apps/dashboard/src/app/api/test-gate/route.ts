/**
 * GET  /api/test-gate  → { config }
 * POST /api/test-gate  → guarda { enabled, command?, timeoutSec, perProject? }
 */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { data } = await bridge("GET", "/test-gate/config").catch(() => ({ code: 0, data: null }));
  return Response.json(data ?? { config: { enabled: true, timeoutSec: 300 } });
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const { code, data } = await bridge("POST", "/test-gate/config", body);
  return Response.json(data ?? { error: "bridge no respondió" }, { status: code || 502 });
}
