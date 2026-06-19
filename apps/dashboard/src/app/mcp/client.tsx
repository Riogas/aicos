"use client";

import { useEffect, useState } from "react";

type Transport = "stdio" | "http" | "sse";
interface Server {
  id?: string; name: string; description?: string; transport: Transport;
  command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean;
}

const argsToText = (a?: string[]) => (a || []).join("\n");
const textToArgs = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);
const envToText = (e?: Record<string, string>) => Object.entries(e || {}).map(([k, v]) => `${k}=${v}`).join("\n");
const textToEnv = (t: string) => {
  const o: Record<string, string> = {};
  for (const l of t.split("\n")) { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return o;
};

export function McpClient() {
  const [servers, setServers] = useState<Server[]>([]);
  const [catalog, setCatalog] = useState<Server[]>([]);
  const [editing, setEditing] = useState<Server | null>(null);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [picking, setPicking] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => fetch("/api/mcp").then((r) => r.json()).then((d) => { setServers(d.servers || []); setCatalog(d.catalog || []); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const startEdit = (s: Server) => { setEditing({ ...s }); setArgsText(argsToText(s.args)); setEnvText(envToText(s.env)); setPicking(false); };
  const fromCatalog = (c: Server) => { startEdit({ ...c, enabled: true }); };

  const save = async () => {
    if (!editing?.name) { setFlash("Falta nombre"); return; }
    const body = { ...editing, args: textToArgs(argsText), env: textToEnv(envText) };
    const r = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { setEditing(null); setFlash("Guardado ✓ — se aplica en el próximo run de los agentes."); load(); } else setFlash(d.error);
  };

  const toggle = async (s: Server) => { await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, enabled: !s.enabled }) }); load(); };
  const del = async (id?: string) => { if (!id || !confirm("¿Borrar este conector?")) return; await fetch(`/api/mcp?id=${id}`, { method: "DELETE" }); load(); };

  const inp = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-hud/40";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Conectores (MCP / tools)</h1>
          <p className="mt-1 text-sm text-subtle">Tools reales para los agentes: GitHub, bases de datos, búsqueda web, tu n8n, etc.</p>
        </div>
        {!editing && <button onClick={() => setPicking(!picking)} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">+ Agregar conector</button>}
        {flash && <span className="text-xs text-success">{flash}</span>}
      </div>

      {/* catálogo */}
      {picking && !editing && (
        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {catalog.map((c) => (
            <button key={c.id} onClick={() => fromCatalog(c)} className="rounded-lg border border-border bg-surface/40 p-3 text-left hover:bg-surface-2">
              <div className="text-sm font-medium text-fg">{c.name}</div>
              <div className="text-xs text-subtle">{c.description}</div>
            </button>
          ))}
        </div>
      )}

      {/* editor */}
      {editing && (
        <section className="mt-5 space-y-4 rounded-xl border border-border bg-surface/40 p-5">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="mb-1 block text-xs font-medium text-muted">Nombre</label><input className={inp} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
            <div><label className="mb-1 block text-xs font-medium text-muted">Tipo</label>
              <select className={inp} value={editing.transport} onChange={(e) => setEditing({ ...editing, transport: e.target.value as Transport })}>
                <option value="stdio">stdio (comando local)</option><option value="http">http (URL)</option><option value="sse">sse (URL)</option>
              </select>
            </div>
          </div>
          {editing.transport === "stdio" ? (
            <>
              <div><label className="mb-1 block text-xs font-medium text-muted">Comando</label><input className={inp + " font-mono"} value={editing.command || ""} onChange={(e) => setEditing({ ...editing, command: e.target.value })} placeholder="npx" /></div>
              <div><label className="mb-1 block text-xs font-medium text-muted">Args (uno por línea)</label><textarea className={inp + " font-mono"} rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} /></div>
            </>
          ) : (
            <div><label className="mb-1 block text-xs font-medium text-muted">URL</label><input className={inp + " font-mono"} value={editing.url || ""} onChange={(e) => setEditing({ ...editing, url: e.target.value })} placeholder="https://tu-servidor/mcp" /></div>
          )}
          <div><label className="mb-1 block text-xs font-medium text-muted">Variables / secrets (KEY=valor, uno por línea)</label><textarea className={inp + " font-mono"} rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..." /></div>
          <div className="flex gap-3">
            <button onClick={save} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Guardar</button>
            <button onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg">Cancelar</button>
          </div>
        </section>
      )}

      {/* lista */}
      <div className="mt-8 space-y-2">
        {servers.length === 0 && !editing && <p className="text-sm text-subtle">No hay conectores configurados todavía.</p>}
        {servers.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
            <button onClick={() => toggle(s)} className={`h-2.5 w-2.5 rounded-full ${s.enabled ? "bg-success" : "bg-ghost"}`} title={s.enabled ? "activo" : "desactivado"} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-fg">{s.name} <span className="font-mono text-2xs text-ghost">{s.transport}</span></div>
              <div className="truncate font-mono text-2xs text-subtle">{s.transport === "stdio" ? `${s.command} ${(s.args || []).join(" ")}` : s.url}</div>
            </div>
            <button onClick={() => startEdit(s)} className="text-xs text-accent hover:underline">editar</button>
            <button onClick={() => del(s.id)} className="text-xs text-danger hover:underline">borrar</button>
          </div>
        ))}
      </div>
    </div>
  );
}
