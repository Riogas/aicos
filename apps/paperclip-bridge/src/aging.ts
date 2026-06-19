/**
 * Aging de tickets trabados (#8).
 *
 * Detecta tickets que llevan demasiado tiempo sin avanzar:
 *   - blocked  más de `blockedHours`     (default 48h / 2 días)
 *   - in_progress más de `inProgressHours` (default 6h — probable run colgado)
 *
 * `agingScan()` lo consulta el dashboard on-demand para resaltar/listar.
 * `agingTick(now)` manda UN digest por Telegram una vez al día (a la hora
 * configurada) — se apoya en aging-last.json para no repetir.
 *
 * Corre en el bridge host (scheduler tick), igual que el standup.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { notify } from "./notify.js";

const HOME = process.env.HOME || "/home/vagrant";
const CFG_PATH = process.env.AICOS_AGING_CONFIG || join(HOME, ".config", "aicos", "aging.json");
const LAST_PATH = process.env.AICOS_AGING_LAST || join(HOME, ".config", "aicos", "aging-last.json");
const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const KEY = process.env.PAPERCLIP_API_KEY || "";
const COMPANY = process.env.AICOS_COMPANY_ID || "";

export interface AgingConfig {
  enabled: boolean;
  blockedHours: number;
  inProgressHours: number;
  hour: number;   // hora del digest diario (0-23)
  minute: number;
}

const DEFAULTS: AgingConfig = { enabled: true, blockedHours: 48, inProgressHours: 6, hour: 9, minute: 0 };

export function loadAgingConfig(): AgingConfig {
  try {
    const d = JSON.parse(readFileSync(CFG_PATH, "utf8"));
    return {
      enabled: d.enabled !== false,
      blockedHours: num(d.blockedHours, DEFAULTS.blockedHours),
      inProgressHours: num(d.inProgressHours, DEFAULTS.inProgressHours),
      hour: clamp(num(d.hour, DEFAULTS.hour), 0, 23),
      minute: clamp(num(d.minute, DEFAULTS.minute), 0, 59),
    };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveAgingConfig(cfg: Partial<AgingConfig>): AgingConfig {
  const cur = loadAgingConfig();
  const next: AgingConfig = {
    enabled: cfg.enabled ?? cur.enabled,
    blockedHours: cfg.blockedHours ?? cur.blockedHours,
    inProgressHours: cfg.inProgressHours ?? cur.inProgressHours,
    hour: cfg.hour ?? cur.hour,
    minute: cfg.minute ?? cur.minute,
  };
  mkdirSync(dirname(CFG_PATH), { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(next, null, 2));
  return next;
}

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface StaleTicket {
  id: string;
  identifier?: string;
  title?: string;
  status: string;
  assignee?: string;
  updatedAt?: string;
  ageHours: number;
}

async function fetchByStatus(status: string): Promise<Record<string, unknown>[]> {
  if (!COMPANY || !KEY) return [];
  try {
    const r = await fetch(`${PAPERCLIP}/api/companies/${COMPANY}/issues?status=${status}`, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : (d.items ?? []);
  } catch {
    return [];
  }
}

function ageHoursOf(i: Record<string, unknown>, now: number): number {
  const ts = (i.updatedAt as string) || (i.updated_at as string) || (i.createdAt as string) || (i.created_at as string);
  const t = ts ? Date.parse(ts) : NaN;
  if (Number.isNaN(t)) return 0;
  return (now - t) / 3_600_000;
}

/** Lista los tickets trabados según los umbrales. */
export async function agingScan(now: number = Date.now()): Promise<{ config: AgingConfig; blocked: StaleTicket[]; inProgress: StaleTicket[] }> {
  const config = loadAgingConfig();
  const [blockedRaw, inProgRaw] = await Promise.all([fetchByStatus("blocked"), fetchByStatus("in_progress")]);
  const toStale = (i: Record<string, unknown>): StaleTicket => ({
    id: String(i.id),
    identifier: (i.identifier as string) ?? undefined,
    title: (i.title as string) ?? undefined,
    status: (i.status as string) ?? "",
    assignee: (i.assigneeAgentId as string) ?? undefined,
    updatedAt: (i.updatedAt as string) ?? (i.updated_at as string) ?? undefined,
    ageHours: Math.round(ageHoursOf(i, now) * 10) / 10,
  });
  const blocked = blockedRaw.map(toStale).filter((s) => s.ageHours >= config.blockedHours).sort((a, b) => b.ageHours - a.ageHours);
  const inProgress = inProgRaw.map(toStale).filter((s) => s.ageHours >= config.inProgressHours).sort((a, b) => b.ageHours - a.ageHours);
  return { config, blocked, inProgress };
}

function loadLast(): { date?: string } {
  try { return JSON.parse(readFileSync(LAST_PATH, "utf8")); } catch { return {}; }
}
function saveLast(date: string): void {
  try { mkdirSync(dirname(LAST_PATH), { recursive: true }); writeFileSync(LAST_PATH, JSON.stringify({ date, ts: new Date().toISOString() })); } catch { /* noop */ }
}

const fmtAge = (h: number) => (h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);

/** Digest diario por Telegram (una vez al día, a la hora configurada). */
export async function agingTick(now: Date = new Date()): Promise<void> {
  const cfg = loadAgingConfig();
  if (!cfg.enabled) return;
  if (now.getHours() !== cfg.hour || now.getMinutes() !== cfg.minute) return;
  const today = now.toISOString().slice(0, 10);
  if (loadLast().date === today) return; // ya avisamos hoy
  saveLast(today);

  const { blocked, inProgress } = await agingScan(now.getTime());
  if (blocked.length === 0 && inProgress.length === 0) return;

  const lines: string[] = [`🕒 *Tickets trabados*`];
  if (blocked.length) {
    lines.push(`\n*${blocked.length} bloqueado(s)* > ${fmtAge(cfg.blockedHours)}:`);
    for (const t of blocked.slice(0, 8)) lines.push(`· ${t.identifier || t.id} — ${fmtAge(t.ageHours)} (${(t.title || "").slice(0, 50)})`);
  }
  if (inProgress.length) {
    lines.push(`\n*${inProgress.length} en ejecución* > ${fmtAge(cfg.inProgressHours)}:`);
    for (const t of inProgress.slice(0, 8)) lines.push(`· ${t.identifier || t.id} — ${fmtAge(t.ageHours)} (¿run colgado?)`);
  }
  lines.push(`\nRevisá el Centro de Control.`);
  await notify(lines.join("\n"));
  process.stderr.write(`[aging] digest enviado: ${blocked.length} blocked, ${inProgress.length} in_progress\n`);
}
