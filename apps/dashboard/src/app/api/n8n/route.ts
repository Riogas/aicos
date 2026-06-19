/**
 * GET    /api/n8n              → { config (sin apiKey), workflows }
 * POST   /api/n8n              → guarda config { enabled, baseUrl, apiKey }
 * PUT    /api/n8n              → upsert de un trigger (webhook pre-registrado)
 * POST   /api/n8n?action=fire  → dispara un trigger { triggerId | url, method?, payload? }
 * DELETE /api/n8n?id=          → borra un trigger
 */
import { publicN8nConfig, saveN8nConfig, listWorkflows, triggerWebhook, upsertTrigger, deleteTrigger } from "@/lib/n8n";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [wf] = await Promise.all([listWorkflows()]);
  return Response.json({ config: publicN8nConfig(), workflows: wf.workflows, workflowsError: wf.ok ? undefined : wf.error });
}

export async function POST(req: Request) {
  const action = new URL(req.url).searchParams.get("action");
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }

  if (action === "fire") {
    const res = await triggerWebhook(body as { triggerId?: string; url?: string; method?: "GET" | "POST"; payload?: unknown });
    return Response.json(res, { status: res.ok ? 200 : 422 });
  }
  // guardar config de conexión
  saveN8nConfig(body as { enabled?: boolean; baseUrl?: string; apiKey?: string });
  return Response.json({ ok: true, config: publicN8nConfig() });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  if (!body.name || !body.webhookUrl) return Response.json({ error: "name y webhookUrl son obligatorios" }, { status: 400 });
  const cfg = upsertTrigger(body as Record<string, never>);
  return Response.json({ ok: true, triggers: cfg.triggers });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "falta id" }, { status: 400 });
  const cfg = deleteTrigger(id);
  return Response.json({ ok: true, triggers: cfg.triggers });
}
