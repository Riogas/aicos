/** GET /api/repos/detail?path=X → archivos top-level + README (restringido a la raíz). */
import { isUnderRoot, listDir, readReadme } from "@/lib/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return Response.json({ error: "falta path" }, { status: 400 });
  if (!isUnderRoot(path)) return Response.json({ error: "path fuera de la raíz" }, { status: 403 });
  return Response.json({ path, files: listDir(path), readme: readReadme(path) });
}
