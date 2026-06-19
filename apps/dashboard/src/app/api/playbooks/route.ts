/**
 * GET    /api/playbooks         → catálogo (built-ins + custom)
 * POST   /api/playbooks         → crear/editar un playbook custom
 * DELETE /api/playbooks?id=     → borrar un playbook custom (built-ins no)
 */
import { listPlaybooks, upsertPlaybook, deletePlaybook } from "@/lib/playbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ playbooks: listPlaybooks() });
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  const b = body as { name?: string; template?: string };
  if (!b.name?.trim() || !b.template?.trim()) return Response.json({ error: "name y template son obligatorios" }, { status: 400 });
  return Response.json({ ok: true, playbook: upsertPlaybook(body as Record<string, unknown>) });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "falta id" }, { status: 400 });
  const ok = deletePlaybook(id);
  return Response.json({ ok, error: ok ? undefined : "no se puede borrar (¿built-in?)" }, { status: ok ? 200 : 400 });
}
