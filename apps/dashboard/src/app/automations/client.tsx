"use client";

import { useEffect, useState } from "react";

interface Trigger { id: string; name: string; description?: string; webhookUrl: string; method: "GET" | "POST" }
interface Cfg { enabled: boolean; baseUrl: string; triggers: Trigger[]; hasApiKey: boolean; apiKeyHint: string }
interface Workflow { id: string; name: string; active: boolean }

export function AutomationsClient() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [wfErr, setWfErr] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<Partial<Trigger> | null>(null);
  const [firing, setFiring] = useState<string>("");
  const [payloads, setPayloads] = useState<Record<string, string>>({});

  const load = () => fetch("/api/n8n").then((r) => r.json()).then((d) => {
    setCfg(d.config); setWorkflows(d.workflows || []); setWfErr(d.workflowsError || null);
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const saveConn = async () => {
    if (!cfg) return;
    const r = await fetch("/api/n8n", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: cfg.enabled, baseUrl: cfg.baseUrl, apiKey }) });
    const d = await r.json();
    if (d.ok) { setApiKey(""); setFlash({ ok: true, text: "Conexión guardada ✓" }); load(); } else setFlash({ ok: false, text: "falló" });
  };

  const saveTrigger = async () => {
    if (!editing?.name || !editing?.webhookUrl) { setFlash({ ok: false, text: "Falta nombre o webhook URL" }); return; }
    const r = await fetch("/api/n8n", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editing) });
    const d = await r.json();
    if (d.ok) { setEditing(null); setFlash({ ok: true, text: "Trigger guardado ✓" }); load(); } else setFlash({ ok: false, text: d.error || "falló" });
  };

  const delTrigger = async (id: string) => {
    if (!confirm("¿Borrar este trigger?")) return;
    await fetch(`/api/n8n?id=${encodeURIComponent(id)}`, { method: "DELETE" }); load();
  };

  const fire = async (t: Trigger) => {
    setFiring(t.id); setFlash(null);
    let payload: unknown = {};
    const raw = payloads[t.id]?.trim();
    if (raw) { try { payload = JSON.parse(raw); } catch { setFlash({ ok: false, text: "El payload no es JSON válido" }); setFiring(""); return; } }
    try {
      const r = await fetch("/api/n8n?action=fire", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triggerId: t.id, payload }) });
      const d = await r.json();
      setFlash(d.ok ? { ok: true, text: `▶ Disparado "${t.name}" (HTTP ${d.status})` } : { ok: false, text: d.error || `falló (HTTP ${d.status})` });
    } catch (e) { setFlash({ ok: false, text: (e as Error).message }); }
    finally { setFiring(""); }
  };

  const inp = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent/40";
  if (!cfg) return <div className="text-muted">Cargando…</div>;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Automatizaciones (n8n)</h1>
          <p className="mt-1 text-sm text-subtle">Dispará workflows de tu n8n desde AICOS — manual, programado o desde un agente.</p>
        </div>
        {flash && <span className={`text-sm ${flash.ok ? "text-success" : "text-danger"}`}>{flash.text}</span>}
      </div>

      {/* conexión */}
      <section className="mt-6 rounded-xl border border-border bg-surface/40 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Conexión</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
            <span className={cfg.enabled ? "text-success" : "text-subtle"}>{cfg.enabled ? "Activa" : "Inactiva"}</span>
          </label>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input className={inp} placeholder="https://n8n.tu-empresa.com" value={cfg.baseUrl} onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} />
          <input className={inp} type="password" autoComplete="off"
            placeholder={cfg.hasApiKey ? `Guardada (${cfg.apiKeyHint}) — vacío para no cambiar` : "X-N8N-API-KEY"}
            value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button onClick={saveConn} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Guardar conexión</button>
          <span className="text-2xs text-subtle">La API key se usa para listar workflows. Los disparos van por webhook.</span>
        </div>
      </section>

      {/* workflows detectados */}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-fg">Workflows en n8n {workflows.length > 0 && <span className="text-subtle">· {workflows.length}</span>}</h2>
        {wfErr ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/20 p-4 text-xs text-subtle">No pude listar: {wfErr}. Verificá baseUrl + API key.</div>
        ) : workflows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/20 p-4 text-xs text-subtle">Sin workflows (o sin conexión todavía).</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {workflows.map((w) => (
              <span key={w.id} className="flex items-center gap-1.5 rounded-md border border-border bg-surface/40 px-2.5 py-1 text-xs">
                <span className={`h-1.5 w-1.5 rounded-full ${w.active ? "bg-success" : "bg-subtle"}`} />
                {w.name}
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-2xs text-subtle">Para disparar uno, agregalo abajo con la URL de su nodo Webhook (Production URL).</p>
      </section>

      {/* triggers */}
      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Disparadores (webhooks)</h2>
          {!editing && <button onClick={() => setEditing({ method: "POST" })} className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10">+ Agregar</button>}
        </div>

        {editing && (
          <div className="mb-3 rounded-xl border border-border bg-surface/40 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input className={inp} placeholder="Nombre (ej: Reporte de prensa)" value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <select className={inp} value={editing.method || "POST"} onChange={(e) => setEditing({ ...editing, method: e.target.value as "GET" | "POST" })}>
                <option value="POST">POST (con payload)</option>
                <option value="GET">GET</option>
              </select>
            </div>
            <input className={`${inp} mt-3`} placeholder="Webhook URL (Production) — ej: https://n8n…/webhook/abc123" value={editing.webhookUrl || ""} onChange={(e) => setEditing({ ...editing, webhookUrl: e.target.value })} />
            <input className={`${inp} mt-3`} placeholder="Descripción (opcional)" value={editing.description || ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            <div className="mt-3 flex gap-3">
              <button onClick={saveTrigger} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Guardar</button>
              <button onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg">Cancelar</button>
            </div>
          </div>
        )}

        {cfg.triggers.length === 0 && !editing ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/20 p-4 text-xs text-subtle">
            Todavía no hay disparadores. Agregá uno con la URL del webhook de un workflow de n8n para poder ejecutarlo desde acá.
          </div>
        ) : (
          <div className="space-y-2">
            {cfg.triggers.map((t) => (
              <div key={t.id} className="rounded-lg border border-border bg-surface/40 p-3">
                <div className="flex items-center gap-3">
                  <span className="text-lg">⚡</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg">{t.name} <span className="font-mono text-2xs text-subtle">{t.method}</span></div>
                    {t.description && <div className="text-xs text-muted">{t.description}</div>}
                    <div className="truncate font-mono text-2xs text-subtle">{t.webhookUrl}</div>
                  </div>
                  <button onClick={() => fire(t)} disabled={firing === t.id || !cfg.enabled} className="rounded-md border border-success/40 px-3 py-1 text-xs font-medium text-success hover:bg-success-soft disabled:opacity-40">
                    {firing === t.id ? "…" : "▶ Disparar"}
                  </button>
                  <button onClick={() => setEditing(t)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg">✎</button>
                  <button onClick={() => delTrigger(t.id)} className="rounded-md px-2 py-1 text-xs text-subtle hover:text-danger">×</button>
                </div>
                {t.method === "POST" && (
                  <textarea className={`${inp} mt-2 min-h-[44px] font-mono text-2xs`} placeholder='Payload JSON opcional (ej: {"motivo":"manual"})' value={payloads[t.id] || ""} onChange={(e) => setPayloads({ ...payloads, [t.id]: e.target.value })} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
