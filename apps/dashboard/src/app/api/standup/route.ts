/** GET /api/standup → {config, last} · POST /api/standup → guarda config */
import { readConfig, writeConfig, readLast } from "@/lib/standup-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ config: readConfig(), last: readLast() });
}
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  return Response.json({ ok: true, config: writeConfig(body) });
}
