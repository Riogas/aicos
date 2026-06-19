/**
 * GET    /api/schedules        → lista
 * POST   /api/schedules        → upsert (un schedule)
 * DELETE /api/schedules?id=X   → borra
 */
import { listSchedules, upsertSchedule, deleteSchedule } from "@/lib/schedule-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ schedules: listSchedules() });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  if (!body.name || !body.cron || !body.prompt) {
    return Response.json({ error: "faltan name/cron/prompt" }, { status: 400 });
  }
  try {
    const s = upsertSchedule(body);
    return Response.json({ ok: true, schedule: s });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "falta id" }, { status: 400 });
  deleteSchedule(id);
  return Response.json({ ok: true });
}
