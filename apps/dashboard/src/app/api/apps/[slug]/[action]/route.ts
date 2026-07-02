/**
 * POST /api/apps/[slug]/start | stop → proxy al bridge
 * GET  /api/apps/[slug]/logs        → proxy al bridge
 */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTIONS = new Set(["start", "stop", "logs"]);

export async function POST(_req: Request, { params }: { params: { slug: string; action: string } }) {
  const { slug, action } = params;
  if (!ACTIONS.has(action) || action === "logs") {
    return Response.json({ error: "acción inválida" }, { status: 400 });
  }
  const { code, data } = await bridge("POST", `/apps/${encodeURIComponent(slug)}/${action}`);
  return Response.json(data ?? { error: "bridge no respondió" }, { status: code || 502 });
}

export async function GET(_req: Request, { params }: { params: { slug: string; action: string } }) {
  if (params.action !== "logs") return Response.json({ error: "acción inválida" }, { status: 400 });
  const { code, data } = await bridge("GET", `/apps/${encodeURIComponent(params.slug)}/logs`);
  return Response.json(data ?? { error: "bridge no respondió" }, { status: code || 502 });
}
