"use client";

import { useEffect, useState } from "react";

type Who = "ceo" | "hermes";
type ModelKey = "opus" | "sonnet";
interface Playbook {
  id: string; name: string; description: string; emoji?: string; category?: string;
  interlocutor?: Who; model?: ModelKey; template: string; builtin?: boolean;
}

const blank: Playbook = { id: "", name: "", description: "", emoji: "📋", category: "Custom", interlocutor: "ceo", model: "opus", template: "" };

export function PlaybooksClient() {
  const [list, setList] = useState<Playbook[]>([]);
  const [editing, setEditing] = useState<Playbook | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => fetch("/api/playbooks").then((r) => r.json()).then((d) => setList(d.playbooks || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.name?.trim() || !editing?.template?.trim()) { setFlash("Falta nombre o plantilla"); return; }
    const r = await fetch("/api/playbooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editing) });
    const d = await r.json();
    if (d.ok) { setEditing(null); setFlash("Guardado ✓"); load(); } else setFlash(d.error || "error");
  };
  const del = async (id: string) => {
    if (!confirm("¿Borrar este playbook?")) return;
    const r = await fetch(`/api/playbooks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const d = await r.json();
    if (!d.ok) setFlash(d.error || "no se pudo borrar");
    load();
  };

  const inp = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent/40";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Playbooks</h1>
          <p className="mt-1 text-sm text-subtle">Plantillas para arrancar trabajo común desde el Strategy Room con un click. Los built-in vienen de fábrica; podés crear los tuyos.</p>
        </div>
        {!editing && <button onClick={() => setEditing({ ...blank })} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">+ Nuevo playbook</button>}
        {flash && <span className="text-xs text-success">{flash}</span>}
      </div>

      {editing && (
        <div className="mt-6 rounded-xl border border-border bg-surface/40 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[80px_1fr_1fr]">
            <input className={inp} placeholder="Emoji" value={editing.emoji || ""} onChange={(e) => setEditing({ ...editing, emoji: e.target.value })} />
            <input className={inp} placeholder="Nombre" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <input className={inp} placeholder="Categoría" value={editing.category || ""} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
          </div>
          <input className={`${inp} mt-3`} placeholder="Descripción corta" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          <div className="mt-3 flex gap-3">
            <select className={inp} value={editing.interlocutor} onChange={(e) => setEditing({ ...editing, interlocutor: e.target.value as Who })}>
              <option value="ceo">Hablar con: CEO</option>
              <option value="hermes">Hablar con: Hermes</option>
            </select>
            <select className={inp} value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value as ModelKey })}>
              <option value="opus">Opus 4.8</option>
              <option value="sonnet">Sonnet 4.6</option>
            </select>
          </div>
          <textarea className={`${inp} mt-3 min-h-[160px] font-mono text-[13px]`} placeholder="Plantilla del mensaje… usá [placeholders] para que el operador complete (ej: [repo], [qué hace])." value={editing.template} onChange={(e) => setEditing({ ...editing, template: e.target.value })} />
          <div className="mt-3 flex items-center gap-3">
            <button onClick={save} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Guardar</button>
            <button onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg">Cancelar</button>
          </div>
        </div>
      )}

      <div className="mt-8 space-y-2">
        {list.map((pb) => (
          <div key={pb.id} className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
            <span className="text-xl">{pb.emoji || "📋"}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-fg">
                {pb.name}
                {pb.category && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-accent">{pb.category}</span>}
                {pb.builtin ? <span className="text-2xs text-subtle">built-in</span> : <span className="text-2xs text-warning">custom</span>}
              </div>
              <div className="mt-0.5 text-xs text-muted">{pb.description}</div>
              <div className="mt-1 font-mono text-2xs text-subtle">→ {pb.interlocutor === "hermes" ? "Hermes" : "CEO"} · {pb.model === "sonnet" ? "Sonnet" : "Opus"}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button onClick={() => setEditing({ ...pb })} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface hover:text-fg" title={pb.builtin ? "Duplicar/editar (se guarda como custom)" : "Editar"}>✎</button>
              {!pb.builtin && <button onClick={() => del(pb.id)} className="rounded-md px-2 py-1 text-xs text-subtle hover:bg-danger-soft hover:text-danger" title="Borrar">×</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
