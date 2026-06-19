/**
 * GET  /api/notifications/config  → config (token enmascarado)
 * POST /api/notifications/config  → guarda config (el token solo se actualiza si mandás uno nuevo)
 */
import { readConfig, writeConfig, maskToken, type NotifyConfig } from "@/lib/notify-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const c = readConfig();
  return Response.json({
    enabled: c.enabled,
    defaultChatId: c.defaultChatId,
    users: c.users,
    hasToken: Boolean(c.botToken),
    tokenHint: maskToken(c.botToken),
  });
}

export async function POST(req: Request) {
  let body: Partial<NotifyConfig> & { botToken?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const current = readConfig();
  const next: NotifyConfig = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    // El token solo se reemplaza si vino uno nuevo no vacío (la UI manda "" para "no cambiar").
    botToken: body.botToken && body.botToken.trim() ? body.botToken.trim() : current.botToken,
    defaultChatId: (body.defaultChatId ?? current.defaultChatId).toString().trim(),
    users: body.users && typeof body.users === "object" ? body.users : current.users,
  };
  try {
    writeConfig(next);
    return Response.json({ ok: true, hasToken: Boolean(next.botToken), tokenHint: maskToken(next.botToken) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
