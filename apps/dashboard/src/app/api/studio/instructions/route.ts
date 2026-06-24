/**
 * GET  /api/studio/instructions            → { instructions }
 * POST /api/studio/instructions { instructions } → guarda las instrucciones
 *      permanentes del CEO (se inyectan en el system prompt de cada conversación
 *      nueva de la Strategy Room).
 */
import { getCeoInstructions, setCeoInstructions } from "@/lib/studio-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ instructions: getCeoInstructions() });
}

export async function POST(req: Request) {
  let body: { instructions?: string } = {};
  try { body = await req.json(); } catch { /* */ }
  if (typeof body.instructions !== "string") {
    return Response.json({ error: "falta instructions" }, { status: 400 });
  }
  const saved = setCeoInstructions(body.instructions);
  return Response.json({ ok: true, instructions: saved });
}
