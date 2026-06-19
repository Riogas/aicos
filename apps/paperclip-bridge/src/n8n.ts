/**
 * Disparo de workflows de n8n desde el bridge (#10) — para uso programático
 * (schedules, agentes, otros servicios). Lee la MISMA config que el dashboard:
 * ~/.config/aicos/n8n.json (home montado).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/home/vagrant";
const STORE = process.env.AICOS_N8N_CONFIG || join(HOME, ".config", "aicos", "n8n.json");

interface N8nTrigger { id: string; name: string; webhookUrl: string; method?: "GET" | "POST" }
interface N8nConfig { enabled: boolean; baseUrl: string; apiKey: string; triggers: N8nTrigger[] }

function load(): N8nConfig {
  try {
    const d = JSON.parse(readFileSync(STORE, "utf8"));
    return { enabled: d.enabled === true, baseUrl: d.baseUrl || "", apiKey: d.apiKey || "", triggers: Array.isArray(d.triggers) ? d.triggers : [] };
  } catch {
    return { enabled: false, baseUrl: "", apiKey: "", triggers: [] };
  }
}

/** Dispara un trigger n8n por nombre/id o URL directa. */
export async function fireN8n(opts: { trigger?: string; url?: string; method?: "GET" | "POST"; payload?: unknown }): Promise<{ ok: boolean; status?: number; error?: string }> {
  const cfg = load();
  if (!cfg.enabled) return { ok: false, error: "n8n deshabilitado" };
  let url = opts.url;
  let method: "GET" | "POST" = opts.method || "POST";
  if (opts.trigger) {
    const t = cfg.triggers.find((x) => x.id === opts.trigger || x.name === opts.trigger);
    if (!t) return { ok: false, error: `trigger "${opts.trigger}" no encontrado` };
    url = t.webhookUrl;
    method = t.method || "POST";
  }
  if (!url) return { ok: false, error: "falta trigger o url" };
  try {
    const r = await fetch(url, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(opts.payload ?? {}) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
