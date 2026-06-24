/**
 * GET  /api/repos                       → { root, projectsRoot, repos }
 * POST /api/repos { root }              → cambia la carpeta raíz a escanear y re-escanea
 * POST /api/repos { projectsRoot }      → cambia la carpeta donde se generan proyectos nuevos
 */
import { getConfig, setRoot, setProjectsRoot, scanRepos } from "@/lib/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { root, projectsRoot } = getConfig();
  return Response.json({ root, projectsRoot, repos: scanRepos(root) });
}

export async function POST(req: Request) {
  let body: { root?: string; projectsRoot?: string } = {};
  try { body = await req.json(); } catch { /* */ }

  if (typeof body.projectsRoot === "string" && body.projectsRoot.trim()) {
    const cfg = setProjectsRoot(body.projectsRoot.trim());
    return Response.json({ ok: true, root: cfg.root, projectsRoot: cfg.projectsRoot, repos: scanRepos(cfg.root) });
  }

  const root = body.root;
  if (!root || !root.trim()) return Response.json({ error: "falta root" }, { status: 400 });
  const cfg = setRoot(root.trim());
  return Response.json({ ok: true, root: cfg.root, projectsRoot: cfg.projectsRoot, repos: scanRepos(cfg.root) });
}
