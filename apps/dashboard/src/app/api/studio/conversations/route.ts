/**
 * GET  /api/studio/conversations      → lista (metadata) de conversaciones (< 7 días)
 * POST /api/studio/conversations      → upsert de una conversación completa
 */
import { listConversations, saveConversation, type StoredConversation } from "@/lib/studio-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ conversations: listConversations() });
}

export async function POST(req: Request) {
  let body: Partial<StoredConversation>;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  if (!body.id || !Array.isArray(body.messages)) {
    return Response.json({ error: "missing id/messages" }, { status: 400 });
  }
  const ok = saveConversation({
    id: body.id,
    title: (body.title || "Sin título").slice(0, 120),
    interlocutor: body.interlocutor || "ceo",
    model: body.model || "opus",
    sessionId: body.sessionId ?? null,
    messages: body.messages,
    createdAt: body.createdAt || 0,
    updatedAt: 0,
  });
  return ok ? Response.json({ ok: true }) : Response.json({ error: "id inválido o no se pudo guardar" }, { status: 400 });
}
