/**
 * GET    /api/knowledge        → lista de documentos ingeridos (proxy al bridge)
 * POST   /api/knowledge        → ingiere un documento { title, text, source?, tags? }
 * DELETE /api/knowledge?docId= → borra un documento por docId
 *
 * El ingest puede tardar (embebe N chunks en CPU), por eso usa timeout largo.
 */
import { BRIDGE } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const res = await fetch(`${BRIDGE}/knowledge/list`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({ documents: [] }));
    return Response.json(data, { status: res.status });
  } catch (e) {
    return Response.json({ documents: [], error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  try {
    const res = await fetch(`${BRIDGE}/knowledge/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(180000), // 3 min: docs largos en embedder CPU
    });
    const data = await res.json().catch(() => ({ ok: false, error: "respuesta no-JSON del bridge" }));
    return Response.json(data, { status: res.status });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const docId = new URL(req.url).searchParams.get("docId");
  if (!docId) return Response.json({ ok: false, error: "falta docId" }, { status: 400 });
  try {
    const res = await fetch(`${BRIDGE}/knowledge/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    return Response.json(data, { status: res.status });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
