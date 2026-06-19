/**
 * GET    /api/studio/conversations/:id  → conversación completa
 * DELETE /api/studio/conversations/:id  → borra la conversación
 */
import { getConversation, deleteConversation } from "@/lib/studio-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const conv = getConversation(params.id);
  if (!conv) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(conv);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ok = deleteConversation(params.id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "no se pudo borrar" }, { status: 400 });
}
