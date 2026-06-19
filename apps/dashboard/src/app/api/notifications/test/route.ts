/**
 * POST /api/notifications/test  → manda un mensaje de prueba al defaultChatId
 * (o a un chatId puntual si lo mandás en el body).
 */
import { readConfig } from "@/lib/notify-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let chatId: string | undefined;
  try { chatId = (await req.json())?.chatId; } catch { /* opcional */ }
  const c = readConfig();
  if (!c.botToken) return Response.json({ error: "falta el token del bot" }, { status: 400 });
  const target = (chatId || c.defaultChatId || "").toString().trim();
  if (!target) return Response.json({ error: "falta un chat ID (default o puntual)" }, { status: 400 });
  try {
    const r = await fetch(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: "🔔 AICOS — notificación de prueba. ¡Funciona!" }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || (d as { ok?: boolean }).ok === false) {
      return Response.json({ error: (d as { description?: string }).description || `Telegram HTTP ${r.status}` }, { status: 502 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
