/** POST /api/control/approve { issueId } → re-lanza el run aprobado (bridge /approve). */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let issueId: string | undefined;
  try { issueId = (await req.json())?.issueId; } catch { /* */ }
  if (!issueId) return Response.json({ error: "falta issueId" }, { status: 400 });
  const { code, data } = await bridge("POST", "/approve", { issueId });
  if (code >= 200 && code < 300) return Response.json({ ok: true, ...data });
  return Response.json({ error: data?.error || `bridge HTTP ${code}` }, { status: 502 });
}
