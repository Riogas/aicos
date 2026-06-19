"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── tipos ────────────────────────────────────────────────────────────────────
type Who = "hermes" | "ceo";
type ModelKey = "opus" | "sonnet";

interface SpecTask {
  ref?: string;
  title: string;
  description?: string;
  agentId?: string;
  dependsOn?: string[];
  subtasks?: SpecTask[];
}
interface AicosSpec {
  title?: string;
  summary?: string;
  newProject?: { name: string; description?: string } | null;
  toolsNeeded?: string[];
  connectionsNeeded?: string[];
  tasks?: SpecTask[];
}
interface Attachment { path: string; name: string; type?: string; size?: number }
interface Msg {
  id: number;
  role: "user" | "agent";
  text: string;
  spec?: AicosSpec;
  streaming?: boolean;
  attachments?: Attachment[];
}
interface RosterAgent { id: string; name: string; department: string; color: string }
interface ConvMeta { id: string; title: string; interlocutor: string; updatedAt: number }
interface Playbook { id: string; name: string; description: string; emoji?: string; category?: string; interlocutor?: Who; model?: ModelKey; template: string; builtin?: boolean }
interface ApplyResult {
  ok?: boolean;
  parent?: { identifier: string };
  projectId?: string;
  created?: { identifier: string; agentId?: string }[];
  warnings?: string[];
  error?: string;
}

const PAPERCLIP_UI = (host: string) => `http://${host}:3100`;
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

function attIcon(type?: string): string {
  const t = type || "";
  if (t.startsWith("image/")) return "🖼";
  if (t.startsWith("audio/")) return "🎵";
  if (t.startsWith("video/")) return "🎬";
  if (t.includes("pdf")) return "📄";
  return "📎";
}

// ── extrae el bloque ```aicos-spec``` del texto del agente ────────────────────
function extractSpec(text: string): { spec?: AicosSpec; clean: string } {
  const m = text.match(/```aicos-spec\s*([\s\S]*?)```/);
  if (!m) return { clean: text };
  try {
    const spec = JSON.parse(m[1].trim()) as AicosSpec;
    return { spec, clean: text.replace(m[0], "").trim() };
  } catch {
    return { clean: text };
  }
}

// ── markdown liviano ──────────────────────────────────────────────────────────
function Rich({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <>
      {blocks.map((blk, i) => {
        if (i % 2 === 1) {
          const nl = blk.indexOf("\n");
          const code = nl >= 0 ? blk.slice(nl + 1) : blk;
          return <pre key={i} className="sr-code"><code>{code.replace(/\n$/, "")}</code></pre>;
        }
        return (
          <div key={i}>
            {blk.split("\n").map((ln, j) => {
              if (!ln.trim()) return <div key={j} className="h-2" />;
              const h = ln.match(/^(#{1,3})\s+(.*)/);
              if (h) return <div key={j} className="sr-h">{inline(h[2])}</div>;
              const b = ln.match(/^\s*[-*]\s+(.*)/);
              if (b) return <div key={j} className="sr-li">{inline(b[1])}</div>;
              return <div key={j} className="sr-p">{inline(ln)}</div>;
            })}
          </div>
        );
      })}
    </>
  );
}
function inline(s: string): React.ReactNode {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} className="sr-ic">{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

function dayGroup(ts: number): string {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return "Hoy";
  if (ts >= startToday - 86400000) return "Ayer";
  return "Últimos 7 días";
}

// ── componente principal ──────────────────────────────────────────────────────
export function StudioClient() {
  const [who, setWho] = useState<Who>("ceo");
  const [model, setModel] = useState<ModelKey>("opus");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [convId, setConvId] = useState<string>(genId());
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [roster, setRoster] = useState<Record<string, RosterAgent>>({});
  const [repos, setRepos] = useState<{ name: string; path: string }[]>([]);
  const [repoPath, setRepoPath] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyRes, setApplyRes] = useState<ApplyResult | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [showPlaybooks, setShowPlaybooks] = useState(false);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // refs para persistir sin closures viejas
  const r = useRef({ messages, sessionId, convId, who, model, repoPath });
  useEffect(() => { r.current = { messages, sessionId, convId, who, model, repoPath }; }, [messages, sessionId, convId, who, model, repoPath]);

  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";

  const loadConvs = useCallback(() => {
    fetch("/api/studio/conversations").then((x) => x.json()).then((d: { conversations: ConvMeta[] }) => setConvs(d.conversations || [])).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/studio/roster").then((x) => x.json()).then((d: { agents: RosterAgent[] }) => {
      const m: Record<string, RosterAgent> = {};
      for (const a of d.agents || []) m[a.id] = a;
      setRoster(m);
    }).catch(() => {});
    fetch("/api/repos").then((x) => x.json()).then((d: { repos: { name: string; path: string }[] }) => setRepos(d.repos || [])).catch(() => {});
    fetch("/api/playbooks").then((x) => x.json()).then((d: { playbooks: Playbook[] }) => setPlaybooks(d.playbooks || [])).catch(() => {});
    loadConvs();
  }, [loadConvs]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const latestSpec = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].spec) return messages[i].spec;
    return undefined;
  }, [messages]);

  const persist = useCallback((msgs: Msg[], sess: string | null) => {
    if (msgs.length === 0) return;
    const firstUser = msgs.find((m) => m.role === "user");
    const title = (firstUser?.text || "Nueva conversación").replace(/\s+/g, " ").slice(0, 60);
    fetch("/api/studio/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.current.convId, title, interlocutor: r.current.who, model: r.current.model, sessionId: sess, messages: msgs }),
    }).then(() => loadConvs()).catch(() => {});
  }, [loadConvs]);

  const newConv = () => {
    setMessages([]); setSessionId(null); setApplyRes(null); setBusy(false);
    setAttachments([]);
    setConvId(genId());
  };

  const usePlaybook = (pb: Playbook) => {
    // Arranca trabajo nuevo: conversación limpia con la plantilla cargada.
    setMessages([]); setSessionId(null); setApplyRes(null); setBusy(false); setAttachments([]);
    setConvId(genId());
    if (pb.interlocutor) setWho(pb.interlocutor);
    if (pb.model) setModel(pb.model);
    setInput(pb.template);
    setShowPlaybooks(false);
    setTimeout(() => { inputRef.current?.focus(); }, 0);
  };

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/studio/upload", { method: "POST", body: fd });
        const d = (await res.json()) as { ok?: boolean; path?: string; name?: string; type?: string; size?: number; error?: string };
        if (d?.ok && d.path) setAttachments((a) => [...a, { path: d.path!, name: d.name || file.name, type: d.type, size: d.size }]);
      } catch { /* noop */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const selectConv = async (id: string) => {
    if (busy || id === convId) return;
    try {
      const c = await fetch(`/api/studio/conversations/${id}`).then((x) => x.json());
      if (c?.error) return;
      setConvId(c.id);
      setMessages(c.messages || []);
      setSessionId(c.sessionId || null);
      if (c.interlocutor === "ceo" || c.interlocutor === "hermes") setWho(c.interlocutor);
      if (c.model === "opus" || c.model === "sonnet") setModel(c.model);
      setApplyRes(null);
    } catch { /* noop */ }
  };

  const delConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/studio/conversations/${id}`, { method: "DELETE" }).catch(() => {});
    if (id === convId) newConv();
    loadConvs();
  };

  const send = useCallback(async () => {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || busy || uploading) return;
    setInput(""); setApplyRes(null); setAttachments([]);
    const base = r.current.messages;
    const userMsg: Msg = { id: ++idRef.current, role: "user", text, attachments: atts.length ? atts : undefined };
    const agentMsg: Msg = { id: ++idRef.current, role: "agent", text: "", streaming: true };
    setMessages((m) => [...m, userMsg, agentMsg]);
    setBusy(true);
    let localSession = r.current.sessionId;

    try {
      const res = await fetch("/api/studio/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interlocutor: r.current.who, message: text || "Analizá los adjuntos.", model: r.current.model, sessionId: localSession, repoPath: r.current.repoPath, attachments: atts }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { type: string; text?: string; sessionId?: string; error?: string };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "session" && ev.sessionId) { localSession = ev.sessionId; setSessionId(ev.sessionId); }
          else if (ev.type === "text" && ev.text) {
            acc += ev.text;
            setMessages((m) => m.map((x) => (x.id === agentMsg.id ? { ...x, text: acc } : x)));
          } else if (ev.type === "error") {
            acc += `\n\n_⚠️ ${ev.error}_`;
            setMessages((m) => m.map((x) => (x.id === agentMsg.id ? { ...x, text: acc } : x)));
          }
        }
      }
      const { spec, clean } = extractSpec(acc);
      const finalAgent: Msg = { ...agentMsg, text: clean || acc, spec, streaming: false };
      const finalMsgs = [...base, userMsg, finalAgent];
      setMessages(finalMsgs);
      persist(finalMsgs, localSession);
    } catch (e) {
      setMessages((m) => m.map((x) => (x.id === agentMsg.id ? { ...x, text: `⚠️ Error: ${(e as Error).message}`, streaming: false } : x)));
    } finally {
      setBusy(false);
    }
  }, [input, busy, uploading, attachments, persist]);

  const applySpec = async (spec: AicosSpec) => {
    setApplying(true); setApplyRes(null);
    try {
      const res = await fetch("/api/studio/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec }) });
      setApplyRes(await res.json());
    } catch (e) {
      setApplyRes({ error: (e as Error).message });
    } finally {
      setApplying(false);
    }
  };

  // agrupar conversaciones por día
  const grouped = useMemo(() => {
    const g: Record<string, ConvMeta[]> = {};
    for (const c of convs) { const k = dayGroup(c.updatedAt); (g[k] ||= []).push(c); }
    return ["Hoy", "Ayer", "Últimos 7 días"].filter((k) => g[k]?.length).map((k) => [k, g[k]] as const);
  }, [convs]);

  return (
    <div className="sr-root">
      <div className="sr-top">
        <div>
          <h1 className="sr-title">Strategy Room</h1>
          <p className="sr-sub">Brainstorm con tu equipo → spec ejecutable → tickets en Paperclip</p>
        </div>
        <div className="sr-controls">
          {playbooks.length > 0 && (
            <div className="sr-pb-wrap">
              <button className="sr-pb-btn" onClick={() => setShowPlaybooks((s) => !s)} disabled={busy} title="Plantillas para arrancar trabajo común">
                📋 Playbooks ▾
              </button>
              {showPlaybooks && (
                <>
                  <div className="sr-pb-backdrop" onClick={() => setShowPlaybooks(false)} />
                  <div className="sr-pb-menu">
                    <div className="sr-pb-menu-h">Arrancá con una plantilla</div>
                    {playbooks.map((pb) => (
                      <button key={pb.id} className="sr-pb-item" onClick={() => usePlaybook(pb)}>
                        <span className="sr-pb-emoji">{pb.emoji || "📋"}</span>
                        <span className="sr-pb-txt">
                          <span className="sr-pb-name">{pb.name}{pb.category && <em className="sr-pb-cat">{pb.category}</em>}</span>
                          <span className="sr-pb-desc">{pb.description}</span>
                        </span>
                      </button>
                    ))}
                    <a className="sr-pb-manage" href="/playbooks">Gestionar playbooks →</a>
                  </div>
                </>
              )}
            </div>
          )}
          <Seg<Who> value={who} onChange={(v) => { setWho(v); newConv(); }} options={[{ k: "ceo", label: "CEO" }, { k: "hermes", label: "Hermes" }]} disabled={busy} />
          <Seg<ModelKey> value={model} onChange={setModel} options={[{ k: "opus", label: "Opus 4.8" }, { k: "sonnet", label: "Sonnet 4.6" }]} disabled={busy} />
          {repos.length > 0 && (
            <select className="sr-reposel" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} disabled={busy} title="Repo de contexto — el agente lo lee">
              <option value="">📁 sin repo</option>
              {repos.map((rp) => <option key={rp.path} value={rp.path}>📁 {rp.name}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="sr-grid">
        {/* sidebar historial */}
        <aside className="sr-side">
          <button className="sr-new" onClick={newConv} disabled={busy}>+ Nueva conversación</button>
          <div className="sr-convs">
            {convs.length === 0 && <div className="sr-side-empty">Tus charlas van a aparecer acá (se guardan 1 semana).</div>}
            {grouped.map(([label, items]) => (
              <div key={label} className="sr-convgrp">
                <div className="sr-convgrp-lbl">{label}</div>
                {items.map((c) => (
                  <div key={c.id} className={`sr-conv ${c.id === convId ? "on" : ""}`} onClick={() => selectConv(c.id)}>
                    <span className="sr-conv-ic" data-who={c.interlocutor}>{c.interlocutor === "ceo" ? "C" : "H"}</span>
                    <span className="sr-conv-title">{c.title}</span>
                    <button className="sr-conv-del" title="Borrar" onClick={(e) => delConv(c.id, e)}>×</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {/* chat */}
        <div className="sr-chat">
          <div className="sr-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="sr-empty">
                <div className="sr-empty-dot" />
                <p>Contale al <b>{who === "ceo" ? "CEO" : "Hermes"}</b> qué querés construir, arreglar o mejorar.</p>
                <p className="sr-empty-hint">Te va a preguntar lo que falte, recomendar y, cuando estén de acuerdo, generar una spec con el desglose de tareas y quién hace cada una.</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`sr-msg ${m.role}`}>
                <div className="sr-bubble">
                  {m.role === "agent" && <div className="sr-who">{who === "ceo" ? "CEO" : "Hermes"}</div>}
                  <div className="sr-text"><Rich text={m.text || (m.streaming ? "…" : "")} /></div>
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="sr-msg-atts">
                      {m.attachments.map((a) => (
                        <span key={a.path} className="sr-att" title={a.name}>{attIcon(a.type)} <span className="sr-att-name">{a.name}</span></span>
                      ))}
                    </div>
                  )}
                  {m.streaming && <span className="sr-cursor" />}
                  {m.spec && <div className="sr-spec-chip">✦ Spec generada — ver panel →</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="sr-inputwrap">
            {(attachments.length > 0 || uploading) && (
              <div className="sr-atts">
                {attachments.map((a, i) => (
                  <span key={a.path} className="sr-att" title={a.name}>
                    {attIcon(a.type)} <span className="sr-att-name">{a.name}</span>
                    <button className="sr-att-x" title="Quitar" onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
                {uploading && <span className="sr-att up">subiendo…</span>}
              </div>
            )}
            <div className="sr-input">
              <button
                className="sr-attach"
                title="Adjuntar evidencia (imagen, audio, video, archivo)"
                onClick={() => fileRef.current?.click()}
                disabled={busy || uploading}
              >📎</button>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={busy ? "El agente está pensando…" : "Escribí tu mensaje… (Enter envía · Shift+Enter salto de línea)"}
                rows={2}
                disabled={busy}
              />
              <button className="sr-send" onClick={send} disabled={busy || uploading || (!input.trim() && attachments.length === 0)}>{busy ? "…" : "Enviar"}</button>
            </div>
          </div>
        </div>

        {/* spec panel */}
        <div className="sr-panel">
          {!latestSpec ? (
            <div className="sr-panel-empty">
              <div className="sr-panel-title">SPEC</div>
              <p>Cuando el agente y vos lleguen a un acuerdo, la spec ejecutable aparece acá con el desglose de tareas, los responsables y un botón para crearla en Paperclip.</p>
            </div>
          ) : (
            <SpecView spec={latestSpec} roster={roster} onApply={() => applySpec(latestSpec)} applying={applying} applyRes={applyRes} host={host} />
          )}
        </div>
      </div>
    </div>
  );
}

function Seg<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: { k: T; label: string }[]; disabled?: boolean }) {
  return (
    <div className="sr-seg">
      {options.map((o) => (
        <button key={o.k} className={value === o.k ? "on" : ""} disabled={disabled} onClick={() => onChange(o.k)}>{o.label}</button>
      ))}
    </div>
  );
}

function SpecView({ spec, roster, onApply, applying, applyRes, host }: { spec: AicosSpec; roster: Record<string, RosterAgent>; onApply: () => void; applying: boolean; applyRes: ApplyResult | null; host: string }) {
  const count = (spec.tasks || []).reduce((n, t) => n + 1 + (t.subtasks?.length || 0), 0);
  return (
    <div className="sr-spec">
      <div className="sr-panel-title">SPEC · {count} tarea{count === 1 ? "" : "s"}</div>
      <h2 className="sr-spec-h">{spec.title || "Spec"}</h2>
      {spec.summary && <p className="sr-spec-sum">{spec.summary}</p>}
      {spec.newProject?.name && <div className="sr-newproj">🗂 Proyecto nuevo: <b>{spec.newProject.name}</b></div>}
      {(spec.toolsNeeded?.length || spec.connectionsNeeded?.length) ? (
        <div className="sr-needs">
          {spec.toolsNeeded?.length ? <div><span className="sr-needs-lbl">Tools</span>{spec.toolsNeeded.map((t, i) => <span key={i} className="sr-chip">{t}</span>)}</div> : null}
          {spec.connectionsNeeded?.length ? <div><span className="sr-needs-lbl">Conexiones</span>{spec.connectionsNeeded.map((t, i) => <span key={i} className="sr-chip warn">{t}</span>)}</div> : null}
        </div>
      ) : null}
      <div className="sr-tasks">{(spec.tasks || []).map((t, i) => <TaskRow key={i} t={t} roster={roster} depth={0} />)}</div>
      {!applyRes?.ok ? (
        <button className="sr-apply" onClick={onApply} disabled={applying}>{applying ? "Creando…" : "Crear en Paperclip (backlog)"}</button>
      ) : null}
      {applyRes && (
        <div className={`sr-result ${applyRes.ok ? "ok" : "err"}`}>
          {applyRes.ok ? (
            <>
              <div>✓ Creado: <b>{applyRes.parent?.identifier}</b> + {applyRes.created?.length || 0} tareas en backlog.</div>
              <a href={PAPERCLIP_UI(host)} target="_blank" rel="noreferrer">Abrir en Paperclip →</a>
              {applyRes.warnings && applyRes.warnings.length > 0 && <ul className="sr-warns">{applyRes.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            </>
          ) : <div>⚠️ {applyRes.error || "no se pudo crear"}</div>}
        </div>
      )}
    </div>
  );
}

function TaskRow({ t, roster, depth }: { t: SpecTask; roster: Record<string, RosterAgent>; depth: number }) {
  const a = t.agentId ? roster[t.agentId] : undefined;
  return (
    <div className="sr-task" style={{ marginLeft: depth * 14 }}>
      <div className="sr-task-head">
        {depth > 0 && <span className="sr-task-tick">└</span>}
        <span className="sr-task-title">{t.title}</span>
        {t.agentId && <span className="sr-agent" style={{ borderColor: (a?.color || "#71717a") + "66", color: a?.color || "#a1a1aa" }}>{a?.name || t.agentId}</span>}
      </div>
      {t.description && <div className="sr-task-desc">{t.description}</div>}
      {(t.subtasks || []).map((s, i) => <TaskRow key={i} t={s} roster={roster} depth={depth + 1} />)}
    </div>
  );
}
