"use client";

import { useEffect, useMemo, useState } from "react";

interface Schedule { id: string; name: string; cron: string; prompt: string; agentId: string; enabled: boolean; createdAt: number }
interface Agent { id: string; name: string; department: string }

type Freq = "hourly" | "daily" | "weekly" | "monthly" | "custom";
const DOW = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function buildCron(freq: Freq, time: string, weekday: number, dom: number, custom: string): string {
  const [h, m] = (time || "09:00").split(":").map((x) => parseInt(x, 10));
  switch (freq) {
    case "hourly": return `${m || 0} * * * *`;
    case "daily": return `${m} ${h} * * *`;
    case "weekly": return `${m} ${h} * * ${weekday}`;
    case "monthly": return `${m} ${h} ${dom} * *`;
    default: return custom.trim() || "0 9 * * *";
  }
}

function cronHuman(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [mi, ho, dom, , dow] = f;
  const at = ho !== "*" ? `${ho.padStart(2, "0")}:${(mi === "*" ? "00" : mi).padStart(2, "0")}` : null;
  if (ho === "*" && dom === "*" && dow === "*") return `cada hora (min ${mi})`;
  if (dow !== "*") return `cada ${DOW[parseInt(dow, 10) % 7] || dow} a las ${at}`;
  if (dom !== "*") return `el día ${dom} de cada mes a las ${at}`;
  if (dom === "*" && dow === "*") return `todos los días a las ${at}`;
  return cron;
}

export function SchedulesClient() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  // form state del constructor de cron
  const [freq, setFreq] = useState<Freq>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [dom, setDom] = useState(1);
  const [custom, setCustom] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => fetch("/api/schedules").then((r) => r.json()).then((d) => setItems(d.schedules || [])).catch(() => {});
  useEffect(() => {
    load();
    fetch("/api/studio/roster").then((r) => r.json()).then((d) => setAgents(d.agents || [])).catch(() => {});
  }, []);

  const cron = useMemo(() => buildCron(freq, time, weekday, dom, custom), [freq, time, weekday, dom, custom]);

  const startNew = () => { setEditing({ name: "", prompt: "", agentId: "ceo", enabled: true }); setFreq("daily"); setTime("09:00"); setCustom(""); };
  const startEdit = (s: Schedule) => { setEditing(s); setFreq("custom"); setCustom(s.cron); };

  const save = async () => {
    if (!editing?.name || !editing?.prompt) { setFlash("Falta nombre o prompt"); return; }
    const body = { ...editing, cron };
    const r = await fetch("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { setEditing(null); setFlash("Guardada ✓"); load(); } else setFlash(d.error || "error");
  };

  const del = async (id: string) => {
    if (!window.confirm("¿Borrar esta tarea programada?")) return;
    await fetch(`/api/schedules?id=${id}`, { method: "DELETE" });
    load();
  };

  const toggle = async (s: Schedule) => {
    await fetch("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, enabled: !s.enabled }) });
    load();
  };

  const inp = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-hud/40";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Tareas programadas</h1>
          <p className="mt-1 text-sm text-subtle">Se crean como tickets recurrentes y los ejecuta el agente que elijas.</p>
        </div>
        {!editing && <button onClick={startNew} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">+ Nueva</button>}
        {flash && <span className="text-sm text-success">{flash}</span>}
      </div>

      {editing && (
        <section className="mt-6 space-y-4 rounded-xl border border-border bg-surface/40 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Nombre</label>
            <input className={inp} value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="ej: Reporte de prensa diario" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Qué hacer (prompt para el agente)</label>
            <textarea className={inp} rows={3} value={editing.prompt || ""} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} placeholder="ej: Generá el reporte de prensa de GLP del día con web_search y resumilo." />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Agente</label>
              <select className={inp} value={editing.agentId || "ceo"} onChange={(e) => setEditing({ ...editing, agentId: e.target.value })}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Frecuencia</label>
              <select className={inp} value={freq} onChange={(e) => setFreq(e.target.value as Freq)}>
                <option value="hourly">Cada hora</option>
                <option value="daily">Diario</option>
                <option value="weekly">Semanal</option>
                <option value="monthly">Mensual</option>
                <option value="custom">Cron personalizado</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {(freq === "daily" || freq === "weekly" || freq === "monthly") && (
              <div><label className="mb-1 block text-xs font-medium text-muted">Hora</label><input type="time" className={inp} value={time} onChange={(e) => setTime(e.target.value)} /></div>
            )}
            {freq === "weekly" && (
              <div><label className="mb-1 block text-xs font-medium text-muted">Día</label><select className={inp} value={weekday} onChange={(e) => setWeekday(parseInt(e.target.value))}>{DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></div>
            )}
            {freq === "monthly" && (
              <div><label className="mb-1 block text-xs font-medium text-muted">Día del mes</label><input type="number" min={1} max={28} className={inp} value={dom} onChange={(e) => setDom(parseInt(e.target.value) || 1)} /></div>
            )}
            {freq === "custom" && (
              <div className="col-span-2"><label className="mb-1 block text-xs font-medium text-muted">Cron (min hora díaMes mes díaSemana)</label><input className={inp + " font-mono"} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0 9 * * 1-5" /></div>
            )}
          </div>
          <p className="text-xs text-subtle">Se ejecutará: <span className="text-hud">{cronHuman(cron)}</span> <span className="font-mono text-ghost">({cron})</span></p>
          <div className="flex gap-3">
            <button onClick={save} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Guardar</button>
            <button onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg">Cancelar</button>
          </div>
        </section>
      )}

      <div className="mt-8 space-y-2">
        {items.length === 0 && !editing && <p className="text-sm text-subtle">No hay tareas programadas todavía.</p>}
        {items.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3">
            <button onClick={() => toggle(s)} className={`h-2.5 w-2.5 rounded-full ${s.enabled ? "bg-success" : "bg-ghost"}`} title={s.enabled ? "activa" : "pausada"} />
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium text-fg">{s.name}</div>
              <div className="truncate text-xs text-subtle">{cronHuman(s.cron)} · {agents.find((a) => a.id === s.agentId)?.name || s.agentId}</div>
            </div>
            <button onClick={() => startEdit(s)} className="text-xs text-accent hover:underline">editar</button>
            <button onClick={() => del(s.id)} className="text-xs text-danger hover:underline">borrar</button>
          </div>
        ))}
      </div>
    </div>
  );
}
