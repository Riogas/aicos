"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Issue { id: string; identifier: string; title: string; status: string; assignee: string; updatedAt?: string }
interface AgingCfg { enabled: boolean; blockedHours: number; inProgressHours: number; hour: number; minute: number }
interface State {
  blocked: Issue[];
  inProgress: Issue[];
  panic: { active: boolean; pausedCount: number; totalAgents: number };
  inflight: number;
}
interface RetryCfg { enabled: boolean; maxAttempts: number; backoffMinutes: number[] }
interface RetryItem { issueId: string; identifier?: string; attempts: number; escalated?: boolean; nextDueAt?: number; lastFailedAt?: string }
interface RetryInfo { config: RetryCfg; pending: RetryItem[]; escalated: RetryItem[] }

export function ControlClient() {
  const [st, setSt] = useState<State | null>(null);
  const [retry, setRetry] = useState<RetryInfo | null>(null);
  const [cfg, setCfg] = useState<RetryCfg | null>(null);
  const [aging, setAging] = useState<AgingCfg | null>(null);
  const [agingDraft, setAgingDraft] = useState<AgingCfg | null>(null);
  const [busy, setBusy] = useState<string>(""); // id+action en curso
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    fetch("/api/control/state").then((r) => r.json()).then(setSt).catch(() => {});
    fetch("/api/retry").then((r) => r.json()).then((d: RetryInfo) => { setRetry(d); setCfg((c) => c ?? d.config); }).catch(() => {});
    fetch("/api/aging").then((r) => r.json()).then((d: { config: AgingCfg }) => { setAging(d.config); setAgingDraft((c) => c ?? d.config); }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 8000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const act = async (url: string, body: unknown, label: string) => {
    setBusy(label); setFlash(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      setFlash(d.ok ? { ok: true, text: "Hecho ✓" } : { ok: false, text: d.error || "falló" });
      load();
    } catch (e) { setFlash({ ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  };

  const ticketAction = (issueId: string, action: string, label: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const url = action === "approve" ? "/api/control/approve" : "/api/control/ticket";
    const body = action === "approve" ? { issueId } : { issueId, action };
    act(url, body, `${issueId}:${label}`);
  };

  const saveCfg = async () => {
    if (!cfg) return;
    setBusy("retrycfg"); setFlash(null);
    try {
      const r = await fetch("/api/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) });
      const d = await r.json();
      setFlash(d.config ? { ok: true, text: "Config guardada ✓" } : { ok: false, text: d.error || "falló" });
      load();
    } catch (e) { setFlash({ ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  };

  const saveAging = async () => {
    if (!agingDraft) return;
    setBusy("agingcfg"); setFlash(null);
    try {
      const r = await fetch("/api/aging", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(agingDraft) });
      const d = await r.json();
      setFlash(d.config ? { ok: true, text: "Aging guardado ✓" } : { ok: false, text: d.error || "falló" });
      if (d.config) setAging(d.config);
    } catch (e) { setFlash({ ok: false, text: (e as Error).message }); }
    finally { setBusy(""); }
  };

  const clearRetry = async (issueId: string) => {
    setBusy(`clear:${issueId}`);
    try { await fetch(`/api/retry?issueId=${encodeURIComponent(issueId)}`, { method: "DELETE" }); load(); }
    finally { setBusy(""); }
  };

  const panic = (action: "pause" | "resume") => {
    const msg = action === "pause"
      ? "⛔ Esto PAUSA todos los agentes y CANCELA los runs en vuelo. ¿Seguro?"
      : "▶ Reanudar todos los agentes?";
    if (!window.confirm(msg)) return;
    act("/api/control/panic", { action }, `panic:${action}`);
  };

  if (!st) return <div className="text-muted">Cargando…</div>;
  const panicActive = st.panic.active;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Centro de Control</h1>
          <p className="mt-1 text-sm text-subtle">Aprobá, re-lanzá o rechazá tickets · pausá todo el sistema.</p>
        </div>
        {flash && <span className={`text-sm ${flash.ok ? "text-success" : "text-danger"}`}>{flash.text}</span>}
      </div>

      {/* Panic */}
      <section className={`mt-6 rounded-xl border p-5 ${panicActive ? "border-warning/40 bg-warning-soft" : "border-border bg-surface/40"}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-fg">{panicActive ? "⏸ Sistema en PAUSA" : "Botón de pánico"}</h2>
            <p className="mt-1 text-xs text-subtle">
              {panicActive
                ? `${st.panic.pausedCount}/${st.panic.totalAgents} agentes pausados — no se despacha nada.`
                : `${st.panic.totalAgents} agentes activos · ${st.inflight} run(s) en vuelo.`}
            </p>
          </div>
          {!panicActive ? (
            <button onClick={() => panic("pause")} disabled={busy.startsWith("panic")}
              className="rounded-lg bg-danger px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              ⛔ Pausar todo
            </button>
          ) : (
            <button onClick={() => panic("resume")} disabled={busy.startsWith("panic")}
              className="rounded-lg bg-success px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              ▶ Reanudar todo
            </button>
          )}
        </div>
      </section>

      {/* Escalados — máxima prioridad */}
      {retry && retry.escalated.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-danger">🚨 Escalados a humano · {retry.escalated.length}</h3>
          <div className="space-y-2">
            {retry.escalated.map((e) => (
              <div key={e.issueId} className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
                <span className="font-mono text-xs text-danger">{e.identifier || e.issueId}</span>
                <span className="flex-1 truncate text-sm text-fg">Falló {e.attempts} reintento(s) automático(s) — necesita intervención.</span>
                <Btn onClick={() => ticketAction(e.issueId, "relaunch", "relaunch")} busy={busy === `${e.issueId}:relaunch`} tone="accent">Re-lanzar</Btn>
                <Btn onClick={() => clearRetry(e.issueId)} busy={busy === `clear:${e.issueId}`} tone="success">Marcar resuelto</Btn>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Reintentos en cola + config */}
      <section className="mt-8 rounded-xl border border-border bg-surface/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-fg">Reintentos automáticos</h3>
            <p className="mt-1 text-xs text-subtle">
              {cfg?.enabled
                ? `Un ticket fallido se re-lanza con backoff hasta ${cfg.maxAttempts} vez/veces; después escala.`
                : "Desactivados — los tickets fallidos quedan bloqueados sin reintentar."}
              {retry && retry.pending.length > 0 && <> · <span className="text-hud">{retry.pending.length} en cola</span></>}
            </p>
          </div>
          {cfg && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
                activos
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                máx
                <input type="number" min={1} max={10} value={cfg.maxAttempts} onChange={(e) => setCfg({ ...cfg, maxAttempts: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                  className="w-14 rounded-md border border-border bg-surface px-2 py-1 text-fg" />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                backoff (min)
                <input type="text" value={cfg.backoffMinutes.join(", ")} onChange={(e) => setCfg({ ...cfg, backoffMinutes: e.target.value.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0) })}
                  className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-fg" placeholder="2, 10, 30" />
              </label>
              <button onClick={saveCfg} disabled={busy === "retrycfg"} className="rounded-md border border-accent/40 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40">
                {busy === "retrycfg" ? "…" : "Guardar"}
              </button>
            </div>
          )}
        </div>
        {retry && retry.pending.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-border/60 pt-3">
            {retry.pending.map((p) => (
              <div key={p.issueId} className="flex items-center gap-3 text-xs">
                <span className="font-mono text-subtle">{p.identifier || p.issueId}</span>
                <span className="text-muted">reintento {p.attempts}/{cfg?.maxAttempts}</span>
                {p.nextDueAt && <span className="text-hud">en {Math.max(0, Math.round((p.nextDueAt - Date.now()) / 60000))} min</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Aging — alertas de tickets trabados */}
      {agingDraft && (
        <section className="mt-8 rounded-xl border border-border bg-surface/40 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-fg">Alertas de tickets trabados</h3>
              <p className="mt-1 text-xs text-subtle">
                {agingDraft.enabled
                  ? `Aviso diario (${String(agingDraft.hour).padStart(2, "0")}:${String(agingDraft.minute).padStart(2, "0")}) por Telegram si hay tickets bloqueados > ${agingDraft.blockedHours}h o en ejecución > ${agingDraft.inProgressHours}h.`
                  : "Desactivadas."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={agingDraft.enabled} onChange={(e) => setAgingDraft({ ...agingDraft, enabled: e.target.checked })} />
                activas
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                blocked &gt;
                <input type="number" min={1} value={agingDraft.blockedHours} onChange={(e) => setAgingDraft({ ...agingDraft, blockedHours: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-fg" />h
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                in-progress &gt;
                <input type="number" min={1} value={agingDraft.inProgressHours} onChange={(e) => setAgingDraft({ ...agingDraft, inProgressHours: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-fg" />h
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                hora
                <input type="number" min={0} max={23} value={agingDraft.hour} onChange={(e) => setAgingDraft({ ...agingDraft, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                  className="w-14 rounded-md border border-border bg-surface px-2 py-1 text-fg" />
              </label>
              <button onClick={saveAging} disabled={busy === "agingcfg"} className="rounded-md border border-accent/40 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40">
                {busy === "agingcfg" ? "…" : "Guardar"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Blocked */}
      <section className="mt-8">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-hud">Necesitan acción · {st.blocked.length}</h3>
        {st.blocked.length === 0 ? (
          <p className="text-sm text-subtle">Nada bloqueado. 👌</p>
        ) : (
          <div className="space-y-2">
            {st.blocked.map((i) => (
              <Row key={i.id} i={i} staleHours={aging?.blockedHours}>
                <Btn onClick={() => ticketAction(i.id, "approve", "approve")} busy={busy === `${i.id}:approve`} tone="success">Aprobar</Btn>
                <Btn onClick={() => ticketAction(i.id, "relaunch", "relaunch")} busy={busy === `${i.id}:relaunch`} tone="accent">Re-lanzar</Btn>
                <Btn onClick={() => ticketAction(i.id, "reject", "reject", `Rechazar ${i.identifier}? (se cancela)`)} busy={busy === `${i.id}:reject`} tone="danger">Rechazar</Btn>
              </Row>
            ))}
          </div>
        )}
      </section>

      {/* In progress */}
      <section className="mt-8">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">En ejecución · {st.inProgress.length}</h3>
        {st.inProgress.length === 0 ? (
          <p className="text-sm text-subtle">Nada corriendo ahora.</p>
        ) : (
          <div className="space-y-2">
            {st.inProgress.map((i) => (
              <Row key={i.id} i={i} staleHours={aging?.inProgressHours}>
                <span className="flex items-center gap-1.5 text-xs text-hud"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-hud" />corriendo</span>
                <Btn onClick={() => ticketAction(i.id, "reject", "reject", `Cancelar ${i.identifier}?`)} busy={busy === `${i.id}:reject`} tone="danger">Cancelar</Btn>
              </Row>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ageHours(updatedAt?: string): number | null {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}
function fmtAge(h: number): string {
  return h >= 48 ? `${Math.round(h / 24)}d` : h >= 1 ? `${Math.round(h)}h` : `${Math.round(h * 60)}m`;
}

function Row({ i, children, staleHours }: { i: Issue; children: React.ReactNode; staleHours?: number }) {
  const h = ageHours(i.updatedAt);
  const stale = h !== null && staleHours !== undefined && h >= staleHours;
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${stale ? "border-warning/50 bg-warning-soft" : "border-border bg-surface/40"}`}>
      <span className="font-mono text-xs text-subtle">{i.identifier}</span>
      <span className="flex-1 truncate text-sm text-fg">{i.title}</span>
      {h !== null && (
        <span className={`font-mono text-2xs ${stale ? "text-warning" : "text-subtle"}`} title={`sin avanzar hace ${fmtAge(h)}`}>
          {stale ? "🕒 " : ""}{fmtAge(h)}
        </span>
      )}
      <span className="text-xs text-muted">{i.assignee}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Btn({ children, onClick, busy, tone }: { children: React.ReactNode; onClick: () => void; busy: boolean; tone: "success" | "accent" | "danger" }) {
  const cls = tone === "success" ? "border-success/40 text-success hover:bg-success-soft"
    : tone === "danger" ? "border-danger/40 text-danger hover:bg-danger-soft"
    : "border-accent/40 text-accent hover:bg-accent/10";
  return (
    <button onClick={onClick} disabled={busy} className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${cls}`}>
      {busy ? "…" : children}
    </button>
  );
}
