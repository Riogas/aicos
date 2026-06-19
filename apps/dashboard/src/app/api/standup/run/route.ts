/** POST /api/standup/run → dispara el standup ahora (bridge). */
const BRIDGE = process.env.BRIDGE_SERVICE_URL || "http://localhost:7100";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const r = await fetch(`${BRIDGE}/standup/run`, { method: "POST", signal: AbortSignal.timeout(90000) });
    const d = await r.json();
    return Response.json(d, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
