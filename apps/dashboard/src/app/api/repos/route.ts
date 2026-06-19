/**
 * GET  /api/repos              → { root, repos }
 * POST /api/repos { root }     → cambia la carpeta raíz y re-escanea
 */
import { getConfig, setRoot, scanRepos } from "@/lib/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { root } = getConfig();
  return Response.json({ root, repos: scanRepos(root) });
}

export async function POST(req: Request) {
  let root: string | undefined;
  try { root = (await req.json())?.root; } catch { /* */ }
  if (!root || !root.trim()) return Response.json({ error: "falta root" }, { status: 400 });
  const cfg = setRoot(root.trim());
  return Response.json({ ok: true, root: cfg.root, repos: scanRepos(cfg.root) });
}
