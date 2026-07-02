/**
 * Horario de trabajo de Paperclip (#11).
 *
 * Define la ventana horaria en la que Paperclip puede despachar tickets a los
 * agentes. Fuera de la ventana, el enforcer pausa (status=paused) los agentes
 * del registry vía la API de board de Paperclip — el heartbeat saltea agentes
 * pausados en TODOS sus paths de dispatch — y los reanuda al entrar en ventana.
 * Así el humano tiene la sesión de IA libre fuera del horario definido.
 *
 * - Config:  ~/.config/aicos/work-schedule.json  (la edita el dashboard, Ajustes)
 * - Estado:  ~/.config/aicos/work-schedule-state.json (qué agentes pausó el
 *   scheduler — al reanudar solo toca esos, respetando pausas manuales)
 *
 * Los runs en curso NO se matan al salir de ventana: terminan solos; solo se
 * frena el despacho de tickets nuevos. El process-mode además chequea la
 * ventana al arrancar (cinturón y tiradores para carreras en el borde).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.HOME || "/home/riogas";
const CFG_PATH =
  process.env.AICOS_WORK_SCHEDULE_CONFIG || join(HOME, ".config", "aicos", "work-schedule.json");
const STATE_PATH = join(dirname(CFG_PATH), "work-schedule-state.json");

export interface DayWindow {
  from: string; // "HH:MM"
  to: string; // "HH:MM"
}

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface WorkScheduleConfig {
  enabled: boolean;
  timezone: string;
  /** Ventanas por día. Día ausente o [] = ese día no se despacha nada. */
  days: Partial<Record<DayKey, DayWindow[]>>;
}

const ALL_DAY: DayWindow[] = [{ from: "00:00", to: "23:59" }];

export const DEFAULT_SCHEDULE: WorkScheduleConfig = {
  enabled: false,
  timezone: "America/Montevideo",
  days: {
    mon: ALL_DAY,
    tue: ALL_DAY,
    wed: ALL_DAY,
    thu: ALL_DAY,
    fri: ALL_DAY,
    sat: ALL_DAY,
    sun: ALL_DAY,
  },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitizeWindows(raw: unknown): DayWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: DayWindow[] = [];
  for (const w of raw) {
    const from = typeof (w as DayWindow)?.from === "string" ? (w as DayWindow).from : "";
    const to = typeof (w as DayWindow)?.to === "string" ? (w as DayWindow).to : "";
    if (HHMM.test(from) && HHMM.test(to)) out.push({ from, to });
  }
  return out;
}

export function loadWorkScheduleConfig(): WorkScheduleConfig {
  try {
    const d = JSON.parse(readFileSync(CFG_PATH, "utf8")) as Partial<WorkScheduleConfig>;
    const days: WorkScheduleConfig["days"] = {};
    const keys: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    for (const k of keys) days[k] = sanitizeWindows(d.days?.[k]);
    return {
      enabled: d.enabled === true,
      timezone: typeof d.timezone === "string" && d.timezone ? d.timezone : DEFAULT_SCHEDULE.timezone,
      days,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } };
  }
}

export function saveWorkScheduleConfig(cfg: Partial<WorkScheduleConfig>): WorkScheduleConfig {
  const cur = loadWorkScheduleConfig();
  const next: WorkScheduleConfig = {
    enabled: cfg.enabled ?? cur.enabled,
    timezone: cfg.timezone ?? cur.timezone,
    days: cfg.days ? cfg.days : cur.days,
  };
  // re-sanitize por si vino del dashboard con basura
  const keys: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const days: WorkScheduleConfig["days"] = {};
  for (const k of keys) days[k] = sanitizeWindows(next.days[k]);
  next.days = days;
  mkdirSync(dirname(CFG_PATH), { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(next, null, 2));
  return next;
}

const DAY_KEYS: Record<string, DayKey> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

/** Día de semana + "HH:MM" actuales en la timezone de la config. */
function nowInTz(timezone: string, now: Date): { day: DayKey; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { day: DAY_KEYS[get("weekday")] ?? "mon", hhmm: `${hour}:${get("minute")}` };
}

/**
 * ¿El instante `now` cae dentro de alguna ventana del día actual?
 * Ventana con from > to se interpreta como cruce de medianoche evaluado en el
 * mismo día (matchea si t >= from o t <= to). Para ventanas nocturnas exactas
 * conviene partirlas en dos días.
 */
export function isWithinSchedule(cfg: WorkScheduleConfig, now: Date = new Date()): boolean {
  if (!cfg.enabled) return true;
  const { day, hhmm } = nowInTz(cfg.timezone, now);
  const windows = cfg.days[day] ?? [];
  for (const w of windows) {
    if (w.from <= w.to) {
      if (hhmm >= w.from && hhmm <= w.to) return true;
    } else if (hhmm >= w.from || hhmm <= w.to) {
      return true;
    }
  }
  return false;
}

// ─── Estado del enforcer (qué pausó el scheduler) ───────────────────────────

interface EnforcerState {
  pausedByScheduler: string[]; // paperclipAgentIds
}

function loadState(): EnforcerState {
  try {
    const d = JSON.parse(readFileSync(STATE_PATH, "utf8")) as EnforcerState;
    return { pausedByScheduler: Array.isArray(d.pausedByScheduler) ? d.pausedByScheduler : [] };
  } catch {
    return { pausedByScheduler: [] };
  }
}

function saveState(s: EnforcerState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
}

export interface EnforcerOptions {
  apiUrl: string;
  /** Token de BOARD (pause/resume exigen assertBoard, la key de agente no sirve). */
  boardToken: string;
  /** paperclipAgentIds a gobernar (los del registry — NUNCA Hermes ni el CEO). */
  agentIds: () => string[];
  log?: (msg: string) => void;
  intervalMs?: number;
}

export interface ScheduleStatus {
  enabled: boolean;
  timezone: string;
  within: boolean;
  pausedByScheduler: number;
}

export function scheduleStatus(): ScheduleStatus {
  const cfg = loadWorkScheduleConfig();
  return {
    enabled: cfg.enabled,
    timezone: cfg.timezone,
    within: isWithinSchedule(cfg),
    pausedByScheduler: loadState().pausedByScheduler.length,
  };
}

async function callAgentAction(
  apiUrl: string,
  boardToken: string,
  agentId: string,
  action: "pause" | "resume",
): Promise<boolean> {
  try {
    const r = await fetch(`${apiUrl}/api/agents/${agentId}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${boardToken}` },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Loop de enforcement: cada `intervalMs` compara ventana vs estado y aplica
 * transiciones. Devuelve stop().
 */
export function startWorkScheduleEnforcer(opts: EnforcerOptions): () => void {
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
  let running = false;

  const tick = async () => {
    if (running) return; // no solapar ticks lentos
    running = true;
    try {
      const cfg = loadWorkScheduleConfig();
      const within = isWithinSchedule(cfg);
      const state = loadState();

      if (!cfg.enabled || within) {
        // Reanudar SOLO lo que pausó el scheduler (respeta pausas manuales).
        if (state.pausedByScheduler.length > 0) {
          const still: string[] = [];
          for (const id of state.pausedByScheduler) {
            const ok = await callAgentAction(opts.apiUrl, opts.boardToken, id, "resume");
            if (!ok) still.push(id); // reintenta el próximo tick
          }
          saveState({ pausedByScheduler: still });
          log(`[work-schedule] ventana ABIERTA — reanudados ${state.pausedByScheduler.length - still.length} agentes${still.length ? ` (${still.length} pendientes)` : ""}`);
        }
        return;
      }

      // Fuera de ventana: pausar los agentes del registry que falten.
      const targets = opts.agentIds().filter((id) => !state.pausedByScheduler.includes(id));
      if (targets.length === 0) return;
      const paused: string[] = [...state.pausedByScheduler];
      for (const id of targets) {
        const ok = await callAgentAction(opts.apiUrl, opts.boardToken, id, "pause");
        if (ok) paused.push(id);
      }
      saveState({ pausedByScheduler: paused });
      log(`[work-schedule] ventana CERRADA — pausados ${paused.length - state.pausedByScheduler.length}/${targets.length} agentes (total ${paused.length})`);
    } finally {
      running = false;
    }
  };

  void tick();
  const t = setInterval(() => void tick(), opts.intervalMs ?? 60_000);
  return () => clearInterval(t);
}
