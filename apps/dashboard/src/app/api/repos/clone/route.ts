/**
 * POST /api/repos/clone { url, name? }
 *   → clona el repo git como subcarpeta dentro de la carpeta de proyectos
 *     (<projectsRoot>/<name>) y devuelve la lista de repos re-escaneada.
 */
import { cloneRepo, getConfig, scanRepos } from "@/lib/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { url?: string; name?: string } = {};
  try { body = await req.json(); } catch { /* */ }
  if (!body.url || !body.url.trim()) {
    return Response.json({ error: "falta url" }, { status: 400 });
  }
  try {
    const res = cloneRepo(body.url.trim(), body.name?.trim());
    const { projectsRoot } = getConfig();
    // re-escaneamos la carpeta de proyectos para que el clon aparezca al toque
    return Response.json({
      ok: true,
      name: res.name,
      path: res.path,
      root: projectsRoot,
      repos: scanRepos(projectsRoot),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message || "clone falló" }, { status: 400 });
  }
}
