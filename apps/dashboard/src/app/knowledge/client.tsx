"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface KnowledgeDoc {
  docId: string;
  title: string;
  source?: string;
  tags?: string[];
  chunks: number;
  chars: number;
  ts: string;
}

const TEXT_EXT = /\.(txt|md|markdown|mdx|csv|tsv|json|ya?ml|log|html?|xml|rtf|tex|org|rst)$/i;
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function KnowledgeClient() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((d: { documents?: KnowledgeDoc[] }) => setDocs(d.documents || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const ingest = async (payload: { title: string; text: string; tags?: string[]; source?: string }) => {
    const r = await fetch("/api/knowledge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await r.json()) as { ok?: boolean; chunks?: number; stored?: number; error?: string };
  };

  const addPasted = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setFlash(null);
    const d = await ingest({ title: title.trim() || "Nota", text, tags: parseTags(tags) });
    setBusy(false);
    if (d.ok) { setFlash(`✓ Ingerido en ${d.stored} chunk${d.stored === 1 ? "" : "s"}.`); setTitle(""); setText(""); setTags(""); load(); }
    else setFlash(`⚠️ ${d.error || "no se pudo ingerir"}`);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length || busy) return;
    setBusy(true); setFlash(null);
    let okN = 0, skip = 0;
    const t = parseTags(tags);
    for (const file of Array.from(files)) {
      if (!TEXT_EXT.test(file.name)) { skip++; continue; }
      try {
        const content = await file.text();
        if (!content.trim()) { skip++; continue; }
        const d = await ingest({ title: file.name, source: file.name, text: content, tags: t });
        if (d.ok) okN++; else skip++;
      } catch { skip++; }
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    setFlash(`✓ ${okN} archivo(s) ingerido(s)${skip ? ` · ${skip} salteado(s) (no es texto o vacío)` : ""}.`);
    load();
  };

  const del = async (docId: string) => {
    if (!confirm("¿Borrar este documento del conocimiento? Los agentes dejan de verlo.")) return;
    await fetch(`/api/knowledge?docId=${encodeURIComponent(docId)}`, { method: "DELETE" }).catch(() => {});
    load();
  };

  const inp = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent/40";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Base de conocimiento</h1>
          <p className="mt-1 text-sm text-subtle">
            Docs, manuales y wikis de la empresa. Lo que cargues acá lo recuperan los agentes y el Strategy Room cuando es relevante (RAG sobre la memoria L4).
          </p>
        </div>
        {flash && <span className="text-xs text-success">{flash}</span>}
      </div>

      {/* alta */}
      <div className="mt-6 rounded-xl border border-border bg-surface/40 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input className={inp} placeholder="Título (ej: Proceso de facturación)" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          <input className={inp} placeholder="Tags separados por coma (opcional)" value={tags} onChange={(e) => setTags(e.target.value)} disabled={busy} />
        </div>
        <textarea
          className={`${inp} mt-3 min-h-[140px] font-mono text-[13px]`}
          placeholder="Pegá el contenido del documento acá… (o subí archivos de texto abajo)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={addPasted} disabled={busy || !text.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            {busy ? "Ingiriendo…" : "Ingerir texto"}
          </button>
          <span className="text-xs text-subtle">o</span>
          <button onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg disabled:opacity-40">
            📄 Subir archivos de texto
          </button>
          <input ref={fileRef} type="file" multiple hidden accept=".txt,.md,.markdown,.mdx,.csv,.tsv,.json,.yaml,.yml,.log,.html,.htm,.xml,.rtf,.tex,.org,.rst,text/*" onChange={(e) => onFiles(e.target.files)} />
          <span className="text-2xs text-subtle">.txt .md .csv .json .yaml .log … (PDF/Word: pegá el texto)</span>
        </div>
      </div>

      {/* lista */}
      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Documentos ingeridos {docs.length > 0 && <span className="text-subtle">· {docs.length}</span>}</h2>
          <button onClick={load} className="text-xs text-muted hover:text-fg">↻ refrescar</button>
        </div>
        {loading ? (
          <div className="rounded-lg border border-border bg-surface/30 p-6 text-center text-sm text-subtle">cargando…</div>
        ) : docs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface/20 p-6 text-center text-sm text-subtle">
            Todavía no hay nada. Cargá tu primer documento arriba (un manual, un proceso, políticas, lo que sea).
          </div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div key={d.docId} className="flex items-center gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
                <span className="text-lg">📄</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{d.title}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-2xs text-subtle">
                    <span>{d.chunks} chunk{d.chunks === 1 ? "" : "s"}</span>
                    <span>{fmtBytes(d.chars)}</span>
                    {d.ts && <span>{d.ts.slice(0, 10)}</span>}
                    {d.tags?.map((t) => <span key={t} className="text-accent">#{t}</span>)}
                  </div>
                </div>
                <button onClick={() => del(d.docId)} className="rounded-md px-2 py-1 text-xs text-subtle hover:bg-danger-soft hover:text-danger" title="Borrar">×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function parseTags(s: string): string[] | undefined {
  const t = s.split(",").map((x) => x.trim()).filter(Boolean);
  return t.length ? t : undefined;
}
