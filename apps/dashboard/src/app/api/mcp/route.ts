/**
 * GET    /api/mcp            → { servers, catalog }
 * POST   /api/mcp           → upsert un servidor
 * DELETE /api/mcp?id=X      → borrar
 */
import { listServers, upsertServer, deleteServer, MCP_CATALOG } from "@/lib/mcp-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ servers: listServers(), catalog: MCP_CATALOG });
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  if (!body.name) return Response.json({ error: "falta name" }, { status: 400 });
  try { return Response.json({ ok: true, server: upsertServer(body) }); }
  catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "falta id" }, { status: 400 });
  deleteServer(id);
  return Response.json({ ok: true });
}
