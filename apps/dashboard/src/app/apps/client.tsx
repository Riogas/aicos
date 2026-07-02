"use client";

import { useCallback, useEffect, useState } from "react";

interface AppService {
  name: string;
  state: string;
  ports: string[];
}

interface AppInfo {
  slug: string;
  path: string;
  tech: string[];
  hasCompose: boolean;
  status: string;
  services: AppService[];
  urls: string[];
  lastOp?: { action: string; startedAt: string; running: boolean; exitCode?: number | null };
}

const STATUS_UI: Record<string, { label: string; cls: string }> = {
  running: { label: "corriendo", cls: "border-success/40 bg-success-soft text-success" },
  partial: { label: "parcial", cls: "border-warning/40 bg-warning-soft text-warning" },
  building: { label: "levantando…", cls: "border-hud/40 bg-surface text-hud animate-pulse" },
  stopping: { label: "parando…", cls: "border-warning/40 bg-warning-soft text-warning animate-pulse" },
  stopped: { label: "detenida", cls: "border-border bg-surface text-subtle" },
  error: { label: "error", cls: "border-danger/40 bg-danger-soft text-danger" },
  "no-launcher": { label: "sin launcher", cls: "border-border bg-surface text-ghost" },
};

export function AppsClient() {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ op: string; services: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await fetch("/api/apps").then((r) => r.json());
      setApps(d.apps ?? []);
    } catch {
      /* mantiene lo último */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (slug: string, action: "start" | "stop") => {
    setBusy(slug); setErr(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/${action}`, { method: "POST" });
      const d = await r.json().catch(() => null);
      if (!r.ok) setErr(d?.error || `no se pudo ${action === "start" ? "levantar" : "parar"} ${slug}`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const showLogs = async (slug: string) => {
    setLogsFor(slug); setLogs(null);
    try {
      const d = await fetch(`/api/apps/${encodeURIComponent(slug)}/logs`).then((r) => r.json());
      setLogs(d);
    } catch {
      setLogs({ op: "(no se pudieron leer los logs)", services: "" });
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold tracking-tight text-fg">Apps</h1>
      <p className="mt-1 text-sm text-subtle">
        Las aplicaciones que construyeron los agentes en la carpeta de proyectos. Las que tienen{" "}
        <code>docker-compose</code> se levantan y paran desde acá, con la tecnología con la que fueron construidas.
      </p>
      {err && <p className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}

      {!apps ? (
        <div className="mt-8 text-muted">Cargando…</div>
      ) : apps.length === 0 ? (
        <div className="mt-8 text-muted">No hay apps en la carpeta de proyectos todavía.</div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {apps.map((a) => {
            const st = STATUS_UI[a.status] ?? STATUS_UI.stopped;
            const opFailed = a.lastOp && !a.lastOp.running && (a.lastOp.exitCode ?? 0) !== 0;
            return (
              <div key={a.slug} className="rounded-xl border border-border bg-surface/40 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-fg" title={a.path}>{a.slug}</h2>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {a.tech.map((t) => (
                        <span key={t} className="rounded border border-border bg-bg/60 px-1.5 py-0.5 font-mono text-2xs text-muted">{t}</span>
                      ))}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-2xs font-medium ${st.cls}`}>{st.label}</span>
                </div>

                {a.services.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {a.services.map((s) => (
                      <div key={s.name} className="flex items-center gap-2 text-xs">
                        <span className={s.state === "running" ? "text-success" : "text-subtle"}>●</span>
                        <span className="text-muted">{s.name}</span>
                        <span className="text-ghost">{s.state}</span>
                        {s.ports.map((p) => <span key={p} className="font-mono text-2xs text-subtle">:{p}</span>)}
                      </div>
                    ))}
                  </div>
                )}

                {a.urls.length > 0 && a.status === "running" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {a.urls.map((u) => (
                      <a key={u} href={u} target="_blank" rel="noreferrer" className="rounded-lg border border-hud/40 px-2.5 py-1 text-xs text-hud hover:bg-surface">
                        {u.replace("http://", "")} ↗
                      </a>
                    ))}
                  </div>
                )}

                {opFailed && (
                  <p className="mt-3 text-xs text-danger">La última operación ({a.lastOp!.action}) falló — mirá los logs.</p>
                )}

                <div className="mt-4 flex items-center gap-2">
                  {a.hasCompose ? (
                    <>
                      <button
                        onClick={() => act(a.slug, "start")}
                        disabled={busy === a.slug || a.status === "building" || a.status === "running"}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                      >
                        {a.status === "building" ? "Levantando…" : a.status === "running" ? "Corriendo" : "Levantar"}
                      </button>
                      <button
                        onClick={() => act(a.slug, "stop")}
                        disabled={busy === a.slug || a.status === "stopped" || a.status === "stopping"}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-fg disabled:opacity-40"
                      >
                        Parar
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-ghost">sin docker-compose — se levanta a mano</span>
                  )}
                  <button onClick={() => showLogs(a.slug)} className="ml-auto rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-fg">
                    Logs
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {logsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setLogsFor(null)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-bg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fg">Logs · {logsFor}</h3>
              <button className="text-subtle hover:text-fg" onClick={() => setLogsFor(null)}>✕</button>
            </div>
            {!logs ? (
              <div className="mt-4 text-sm text-muted">Cargando…</div>
            ) : (
              <div className="mt-3 max-h-[65vh] space-y-3 overflow-auto">
                {logs.op && (
                  <div>
                    <div className="mb-1 font-mono text-2xs uppercase text-subtle">última operación</div>
                    <pre className="whitespace-pre-wrap rounded-md border border-border/60 bg-surface/40 p-3 text-2xs leading-relaxed text-fg/90">{logs.op}</pre>
                  </div>
                )}
                {logs.services && (
                  <div>
                    <div className="mb-1 font-mono text-2xs uppercase text-subtle">servicios</div>
                    <pre className="whitespace-pre-wrap rounded-md border border-border/60 bg-surface/40 p-3 text-2xs leading-relaxed text-fg/90">{logs.services}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
