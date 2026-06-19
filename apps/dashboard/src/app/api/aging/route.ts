/**
 * GET  /api/aging  → { config, blocked[], inProgress[] } (tickets trabados)
 * POST /api/aging  → guarda config { enabled, blockedHours, inProgressHours, hour, minute }
 */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { data } = await bridge("GET", "/aging/scan").catch(() => ({ code: 0, data: null }));
  return Response.json(
    data ?? { config: { enabled: true, blockedHours: 48, inProgressHours: 6, hour: 9, minute: 0 }, blocked: [], inProgress: [] },
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const { code, data } = await bridge("POST", "/aging/config", body);
  return Response.json(data ?? { error: "bridge no respondió" }, { status: code || 502 });
}
