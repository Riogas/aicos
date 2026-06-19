"use client";

import { useEffect, useState } from "react";

interface Cfg {
  enabled: boolean;
  defaultChatId: string;
  users: Record<string, string>;
  hasToken: boolean;
  tokenHint: string;
}

export function SettingsClient() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [token, setToken] = useState(""); // vacío = no cambiar
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [userPairs, setUserPairs] = useState<{ u: string; c: string }[]>([]);
  // standup
  const [su, setSu] = useState<{ enabled: boolean; time: string } | null>(null);
  const [suLast, setSuLast] = useState<{ at: string; text: string } | null>(null);
  const [suBusy, setSuBusy] = useState(false);

  useEffect(() => {
    fetch("/api/notifications/config").then((r) => r.json()).then((d: Cfg) => {
      setCfg(d);
      setUserPairs(Object.entries(d.users || {}).map(([u, c]) => ({ u, c })));
    }).catch(() => {});
    fetch("/api/standup").then((r) => r.json()).then((d) => { setSu(d.config); setSuLast(d.last); }).catch(() => {});
  }, []);

  const saveStandup = async (patch: Partial<{ enabled: boolean; time: string }>) => {
    const next = { ...(su || { enabled: false, time: "18:00" }), ...patch };
    setSu(next);
    await fetch("/api/standup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => {});
  };
  const runStandup = async () => {
    setSuBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/standup/run", { method: "POST" });
      const d = await r.json();
      if (d.ok) { setSuLast({ at: new Date().toISOString(), text: d.text }); setMsg({ ok: true, text: "Standup enviado." }); }
      else setMsg({ ok: false, text: d.error || "falló" });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setSuBusy(false); }
  };

  if (!cfg) return <div className="text-muted">Cargando…</div>;

  const usersObj = () => {
    const o: Record<string, string> = {};
    for (const p of userPairs) if (p.u.trim() && p.c.trim()) o[p.u.trim()] = p.c.trim();
    return o;
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/notifications/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: cfg.enabled, defaultChatId: cfg.defaultChatId, users: usersObj(), botToken: token }),
      });
      const d = await r.json();
      if (d.ok) { setCfg({ ...cfg, hasToken: d.hasToken, tokenHint: d.tokenHint }); setToken(""); setMsg({ ok: true, text: "Guardado." }); }
      else setMsg({ ok: false, text: d.error || "no se pudo guardar" });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setMsg(null);
    try {
      const r = await fetch("/api/notifications/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json();
      setMsg(d.ok ? { ok: true, text: "Mensaje de prueba enviado ✓" } : { ok: false, text: d.error || "falló el envío" });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setTesting(false); }
  };

  const inp = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-hud/40";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight text-fg">Ajustes</h1>
      <p className="mt-1 text-sm text-subtle">Configuración del sistema AICOS.</p>

      <section className="mt-8 rounded-xl border border-border bg-surface/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-fg">Notificaciones por Telegram</h2>
            <p className="mt-1 text-xs text-subtle">Avisos cuando un ticket termina, falla o necesita aprobación.</p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
            <span className={cfg.enabled ? "text-success" : "text-subtle"}>{cfg.enabled ? "Activadas" : "Desactivadas"}</span>
          </label>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Token del bot</label>
            <input className={inp} type="password" autoComplete="off"
              placeholder={cfg.hasToken ? `Guardado (${cfg.tokenHint}) — dejá vacío para no cambiarlo` : "123456:ABC-DEF…"}
              value={token} onChange={(e) => setToken(e.target.value)} />
            <p className="mt-1 text-2xs text-subtle">Lo creás con @BotFather en Telegram. Es un solo bot general para todo AICOS.</p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Chat ID por defecto</label>
            <input className={inp} value={cfg.defaultChatId} onChange={(e) => setCfg({ ...cfg, defaultChatId: e.target.value })} placeholder="ej: 123456789" />
            <p className="mt-1 text-2xs text-subtle">A dónde van los avisos hasta tener login por usuario. (Obtené tu chat ID escribiéndole al bot y mirando @userinfobot.)</p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Chat IDs por usuario <span className="text-ghost">(se activan con el login AD)</span></label>
            <div className="space-y-2">
              {userPairs.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input className={inp + " flex-1"} placeholder="usuario" value={p.u} onChange={(e) => setUserPairs(userPairs.map((x, j) => j === i ? { ...x, u: e.target.value } : x))} />
                  <input className={inp + " flex-1"} placeholder="chat ID" value={p.c} onChange={(e) => setUserPairs(userPairs.map((x, j) => j === i ? { ...x, c: e.target.value } : x))} />
                  <button className="rounded-lg border border-border px-3 text-subtle hover:text-danger" onClick={() => setUserPairs(userPairs.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              <button className="text-xs text-hud hover:underline" onClick={() => setUserPairs([...userPairs, { u: "", c: "" }])}>+ agregar usuario</button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button onClick={save} disabled={saving} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Guardando…" : "Guardar"}</button>
          <button onClick={test} disabled={testing || !cfg.hasToken} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg disabled:opacity-40">{testing ? "Enviando…" : "Enviar prueba"}</button>
          {msg && <span className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</span>}
        </div>
      </section>

      {/* Daily standup */}
      <section className="mt-6 rounded-xl border border-border bg-surface/40 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-fg">Daily standup del CEO</h2>
            <p className="mt-1 text-xs text-subtle">Resumen diario de lo trabajado (completadas/en curso/bloqueadas), por Telegram.</p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={su?.enabled || false} onChange={(e) => saveStandup({ enabled: e.target.checked })} />
            <span className={su?.enabled ? "text-success" : "text-subtle"}>{su?.enabled ? "Activado" : "Desactivado"}</span>
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Hora</label>
            <input type="time" className={inp + " w-auto"} value={su?.time || "18:00"} onChange={(e) => saveStandup({ time: e.target.value })} />
          </div>
          <button onClick={runStandup} disabled={suBusy} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-fg disabled:opacity-40">{suBusy ? "Generando…" : "Enviar ahora"}</button>
          <span className="text-xs text-subtle">Usa el bot configurado arriba.</span>
        </div>
        {suLast && (
          <div className="mt-5">
            <div className="mb-1 font-mono text-2xs uppercase tracking-tightest text-subtle">último standup · {new Date(suLast.at).toLocaleString("es-UY")}</div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-bg/60 p-3 text-xs leading-relaxed text-fg/90">{suLast.text}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
