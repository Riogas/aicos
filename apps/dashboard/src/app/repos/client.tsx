"use client";

import { useEffect, useState } from "react";

interface Repo { name: string; path: string; git: boolean; branch?: string; kind: string; description?: string }
interface Detail { path: string; files: { name: string; dir: boolean }[]; readme: string | null }

const KIND_COLOR: Record<string, string> = {
  next: "#00ff9c", node: "#22c55e", python: "#00e676", go: "#06b6d4", rust: "#f59e0b",
  php: "#a855f7", docker: "#60a5fa", repo: "#a1a1aa", folder: "#71717a",
};

export function ReposClient() {
  const [root, setRoot] = useState("");
  const [draftRoot, setDraftRoot] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sel, setSel] = useState<Repo | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [draftProjects, setDraftProjects] = useState("");
  const [flashP, setFlashP] = useState<string | null>(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [flashC, setFlashC] = useState<string | null>(null);

  const load = () => fetch("/api/repos").then((r) => r.json()).then((d) => { setRoot(d.root); setDraftRoot(d.root); setProjectsRoot(d.projectsRoot || ""); setDraftProjects(d.projectsRoot || ""); setRepos(d.repos || []); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const saveRoot = async () => {
    setFlash(null);
    const r = await fetch("/api/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: draftRoot }) });
    const d = await r.json();
    if (d.ok) { setRoot(d.root); setRepos(d.repos || []); setSel(null); setDetail(null); setFlash(`Escaneados ${d.repos.length} repos.`); }
    else setFlash(d.error || "error");
  };

  const saveProjects = async () => {
    setFlashP(null);
    const r = await fetch("/api/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectsRoot: draftProjects }) });
    const d = await r.json();
    if (d.ok) { setProjectsRoot(d.projectsRoot); setFlashP(`Guardado. Los proyectos nuevos se crean en ${d.projectsRoot}/<nombre>.`); }
    else setFlashP(d.error || "error");
  };

  const doClone = async () => {
    setFlashC(null);
    if (!cloneUrl.trim()) { setFlashC("Pegá una URL de git."); return; }
    setCloning(true);
    try {
      const r = await fetch("/api/repos/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: cloneUrl, name: cloneName }) });
      const d = await r.json();
      if (d.ok) {
        setCloneUrl(""); setCloneName("");
        setRoot(d.root); setDraftRoot(d.root); setRepos(d.repos || []); setSel(null); setDetail(null);
        setFlashC(`✓ Clonado en ${d.path}`);
      } else setFlashC(d.error || "error");
    } catch { setFlashC("error de red"); } finally { setCloning(false); }
  };

  const open = async (repo: Repo) => {
    setSel(repo); setDetail(null); setLoading(true);
    try {
      const d = await fetch(`/api/repos/detail?path=${encodeURIComponent(repo.path)}`).then((r) => r.json());
      setDetail(d);
    } catch { /* */ } finally { setLoading(false); }
  };

  const inp = "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-hud/40";

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Repositorios</h1>
        <p className="mt-1 text-sm text-subtle">Carpeta raíz que escanea Matrix. Los repos son accesibles por los agentes (están en el filesystem montado).</p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input className={inp + " flex-1 min-w-[280px] font-mono"} value={draftRoot} onChange={(e) => setDraftRoot(e.target.value)} placeholder="/home/vagrant" />
        <button onClick={saveRoot} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Escanear</button>
        {flash && <span className="text-sm text-success">{flash}</span>}
      </div>

      {/* Carpeta de proyectos nuevos (greenfield) */}
      <div className="mt-6 rounded-xl border border-border bg-surface/40 p-4">
        <h2 className="text-sm font-semibold text-fg">Carpeta de proyectos nuevos</h2>
        <p className="mt-1 text-2xs text-subtle">
          Cuando los agentes arman un <span className="text-muted">proyecto nuevo</span>, se crea como subcarpeta acá:{" "}
          <span className="font-mono text-hud">{(projectsRoot || "…")}/&lt;nombre-del-proyecto&gt;</span>. Tiene que ser una ruta dentro del home montado para que la vean los agentes.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className={inp + " flex-1 min-w-[280px] font-mono"} value={draftProjects} onChange={(e) => setDraftProjects(e.target.value)} placeholder="/home/riogas/Projects" />
          <button onClick={saveProjects} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Guardar</button>
          {flashP && <span className="text-sm text-success">{flashP}</span>}
        </div>

        {/* Clonar app desde una URL de git */}
        <div className="mt-5 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-fg">Clonar app</h3>
          <p className="mt-1 text-2xs text-subtle">
            Pegá la URL del repo y se clona como subcarpeta dentro de la carpeta de proyectos. Para repos privados, incluí el token en la URL
            (<span className="font-mono">https://x-access-token:TU_PAT@github.com/org/app.git</span>) — lo limpiamos del remoto tras clonar.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input className={inp + " flex-1 min-w-[320px] font-mono"} value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} placeholder="https://github.com/org/app.git" disabled={cloning} />
            <input className={inp + " w-44 font-mono"} value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="carpeta (opcional)" disabled={cloning} />
            <button onClick={doClone} disabled={cloning} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{cloning ? "Clonando…" : "Clonar"}</button>
          </div>
          {flashC && <span className="mt-2 block text-sm text-success">{flashC}</span>}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        {/* lista */}
        <div className="space-y-2">
          {repos.length === 0 ? (
            <p className="text-sm text-subtle">No detecté repos/apps en <span className="font-mono text-muted">{root}</span>.</p>
          ) : repos.map((r) => (
            <button key={r.path} onClick={() => open(r)} className={`block w-full rounded-lg border px-4 py-3 text-left transition-colors ${sel?.path === r.path ? "border-hud/40 bg-surface-2" : "border-border bg-surface/40 hover:bg-surface-2"}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-fg">{r.name}</span>
                <span className="rounded px-1.5 py-0.5 text-2xs font-semibold" style={{ color: KIND_COLOR[r.kind] || "#a1a1aa", background: (KIND_COLOR[r.kind] || "#a1a1aa") + "1a" }}>{r.kind}</span>
                {r.git && r.branch && <span className="font-mono text-2xs text-subtle">⎇ {r.branch}</span>}
              </div>
              {r.description && <div className="mt-1 truncate text-xs text-subtle">{r.description}</div>}
            </button>
          ))}
        </div>

        {/* detalle */}
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          {!sel ? (
            <p className="text-sm text-subtle">Elegí un repo para ver sus archivos y README.</p>
          ) : (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-fg">{sel.name}</span>
                <span className="font-mono text-2xs text-ghost">{sel.path}</span>
              </div>
              {loading ? <p className="text-xs text-muted">Cargando…</p> : detail && (
                <>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {detail.files.map((f) => (
                      <span key={f.name} className={`rounded px-2 py-0.5 font-mono text-2xs ${f.dir ? "bg-surface-3 text-hud" : "bg-surface-2 text-muted"}`}>{f.dir ? "📁" : "📄"} {f.name}</span>
                    ))}
                  </div>
                  {detail.readme && (
                    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-bg/60 p-3 text-xs leading-relaxed text-fg/90">{detail.readme}</pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
