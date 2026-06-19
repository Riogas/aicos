/**
 * Integración con n8n (#10): disparar workflows desde AICOS.
 *
 * Config en ~/.config/aicos/n8n.json (mismo home montado → lo lee también el
 * bridge para disparos programáticos desde schedules/agentes):
 *   { enabled, baseUrl, apiKey, triggers: [{id,name,description?,webhookUrl,method}] }
 *
 * - baseUrl + apiKey → listar workflows via la API pública de n8n (X-N8N-API-KEY)
 * - triggers → webhooks pre-registrados que se disparan con un click + payload
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const STORE = process.env.AICOS_N8N_CONFIG || join(HOME, ".config", "aicos", "n8n.json");

export interface N8nTrigger {
  id: string;
  name: string;
  description?: string;
  webhookUrl: string;
  method: "GET" | "POST";
}
export interface N8nConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  triggers: N8nTrigger[];
}

const EMPTY: N8nConfig = { enabled: false, baseUrl: "", apiKey: "", triggers: [] };

export function loadN8nConfig(): N8nConfig {
  try {
    const d = JSON.parse(readFileSync(STORE, "utf8"));
    return {
      enabled: d.enabled === true,
      baseUrl: (d.baseUrl || "").replace(/\/+$/, ""),
      apiKey: d.apiKey || "",
      triggers: Array.isArray(d.triggers) ? d.triggers : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveN8nConfig(input: Partial<N8nConfig>): N8nConfig {
  const cur = loadN8nConfig();
  const next: N8nConfig = {
    enabled: input.enabled ?? cur.enabled,
    baseUrl: (input.baseUrl ?? cur.baseUrl).replace(/\/+$/, ""),
    // apiKey vacío = no cambiar (no pisás el guardado con "")
    apiKey: input.apiKey !== undefined && input.apiKey !== "" ? input.apiKey : cur.apiKey,
    triggers: input.triggers ?? cur.triggers,
  };
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(next, null, 2));
  return next;
}

/** Versión sin secreto para mandar al cliente. */
export function publicN8nConfig(c: N8nConfig = loadN8nConfig()): Omit<N8nConfig, "apiKey"> & { hasApiKey: boolean; apiKeyHint: string } {
  return {
    enabled: c.enabled,
    baseUrl: c.baseUrl,
    triggers: c.triggers,
    hasApiKey: Boolean(c.apiKey),
    apiKeyHint: c.apiKey ? `…${c.apiKey.slice(-6)}` : "",
  };
}

export interface N8nWorkflow { id: string; name: string; active: boolean }

/** Lista workflows desde la API pública de n8n. */
export async function listWorkflows(): Promise<{ ok: boolean; workflows: N8nWorkflow[]; error?: string }> {
  const c = loadN8nConfig();
  if (!c.baseUrl || !c.apiKey) return { ok: false, workflows: [], error: "falta baseUrl o apiKey" };
  try {
    const r = await fetch(`${c.baseUrl}/api/v1/workflows?limit=200`, {
      headers: { "X-N8N-API-KEY": c.apiKey, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { ok: false, workflows: [], error: `n8n API ${r.status}` };
    const d = (await r.json()) as { data?: { id: string; name: string; active: boolean }[] };
    return { ok: true, workflows: (d.data ?? []).map((w) => ({ id: String(w.id), name: w.name, active: !!w.active })) };
  } catch (e) {
    return { ok: false, workflows: [], error: (e as Error).message };
  }
}

/** Dispara un webhook de n8n (por id de trigger guardado o URL directa). */
export async function triggerWebhook(opts: { triggerId?: string; url?: string; method?: "GET" | "POST"; payload?: unknown }): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  const c = loadN8nConfig();
  let url = opts.url;
  let method: "GET" | "POST" = opts.method || "POST";
  if (opts.triggerId) {
    const t = c.triggers.find((x) => x.id === opts.triggerId);
    if (!t) return { ok: false, error: "trigger no encontrado" };
    url = t.webhookUrl;
    method = t.method || "POST";
  }
  if (!url) return { ok: false, error: "falta url o triggerId" };
  try {
    const r = await fetch(url, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(opts.payload ?? {}) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const body = (await r.text().catch(() => "")).slice(0, 600);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trigger";

export function upsertTrigger(input: Partial<N8nTrigger>): N8nConfig {
  const c = loadN8nConfig();
  const id = input.id || slug(input.name || "trigger") + "-" + Math.random().toString(36).slice(2, 6);
  const t: N8nTrigger = {
    id,
    name: input.name || id,
    description: input.description,
    webhookUrl: input.webhookUrl || "",
    method: input.method === "GET" ? "GET" : "POST",
  };
  const triggers = c.triggers.some((x) => x.id === id) ? c.triggers.map((x) => (x.id === id ? t : x)) : [...c.triggers, t];
  return saveN8nConfig({ triggers });
}

export function deleteTrigger(id: string): N8nConfig {
  const c = loadN8nConfig();
  return saveN8nConfig({ triggers: c.triggers.filter((x) => x.id !== id) });
}
