"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Issue { id: string; identifier: string; title: string; status: string; assignee: string }
interface State {
  blocked: Issue[];
  inProgress: Issue[];
  panic: { active: boolean; pausedCount: number; totalAgents: number };
  inflight: number;
}

export function ControlClient() {
  const [st, setSt] = useState<State | null>(null);
  const [busy, setBusy] = useState<string>(""); // id+action en curso
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    fetch("/api/control/state").then((r) => r.json()).then(setSt).catch(() => {});
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

      {/* Blocked */}
      <section className="mt-8">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-hud">Necesitan acción · {st.blocked.length}</h3>
        {st.blocked.length === 0 ? (
          <p className="text-sm text-subtle">Nada bloqueado. 👌</p>
        ) : (
          <div className="space-y-2">
            {st.blocked.map((i) => (
              <Row key={i.id} i={i}>
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
              <Row key={i.id} i={i}>
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

function Row({ i, children }: { i: Issue; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
      <span className="font-mono text-xs text-subtle">{i.identifier}</span>
      <span className="flex-1 truncate text-sm text-fg">{i.title}</span>
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
