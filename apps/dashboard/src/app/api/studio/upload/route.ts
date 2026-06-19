/**
 * POST /api/studio/upload (multipart) → guarda un adjunto en el home montado
 * (legible por el agente dentro del container) y devuelve su path para
 * referenciarlo en la charla. claude puede leerlo con su tool Read (imágenes →
 * visión, PDF/texto → contenido).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const UPLOAD_DIR = process.env.AICOS_UPLOAD_DIR || join(HOME, ".local", "share", "aicos", "uploads");
const MAX = 50 * 1024 * 1024; // 50 MB

export async function POST(req: Request) {
  let form: FormData;
  try { form = await req.formData(); } catch { return Response.json({ error: "esperaba multipart/form-data" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "falta el archivo" }, { status: 400 });
  if (file.size > MAX) return Response.json({ error: "archivo > 50MB" }, { status: 413 });

  const safeName = (file.name || "adjunto").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "adjunto";
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const dir = join(UPLOAD_DIR, id);
  try {
    mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    const path = join(dir, safeName);
    writeFileSync(path, buf);
    return Response.json({ ok: true, path, name: file.name, type: file.type || "", size: buf.length });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
