/**
 * Reintentos inteligentes + reintento persistente.
 *
 * Cuando un run termina FALLIDO (exit!=0) o VACÍO (exit 0 sin output útil — p.ej.
 * timeout/reconnect del CLI), el ticket se re-lanza automáticamente con backoff
 * exponencial hasta N intentos. Agotados esos, pasa a MODO PERSISTENTE (pedido
 * del operador 2026-07-02): se sigue reintentando para siempre cada
 * `persistEveryMinutes` (default 30), pero SOLO dentro del horario laboral —
 * si la ventana cierra, el reintento queda pendiente y dispara al abrir la
 * ventana del día siguiente. Esto cubre "claude sin tokens": cuando la sesión
 * levanta, el próximo reintento dentro de ventana lo retoma solo. Sin mails.
 *
 * El re-lanzamiento usa el mecanismo canónico: PATCH status=todo → Paperclip
 * re-despacha el ticket al agente. El procesamiento de los reintentos diferidos
 * lo hace el scheduler (tick cada 30s en el bridge host), por eso sobrevive a
 * reinicios (el estado se persiste a disco).
 *
 * Runs HELD por policy (awaiting-approval / denied) NO se reintentan.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadWorkScheduleConfig, isWithinSchedule } from "./work-schedule.js";

const HOME = process.env.HOME || "/home/vagrant";
const CFG_PATH = process.env.AICOS_RETRY_CONFIG || join(HOME, ".config", "aicos", "retry.json");
const STATE_PATH = process.env.AICOS_RETRY_STATE || join(HOME, ".config", "aicos", "retry-state.json");
const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const KEY = process.env.PAPERCLIP_API_KEY || "";

export type Disposition = "completed" | "failed" | "empty" | "held";

export interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;       // reintentos con backoff antes del modo persistente
  backoffMinutes: number[];  // espera por reintento (se usa el último si faltan)
  /** Modo persistente: cadencia del reintento eterno (min). 0 = desactivado (escala y para). */
  persistEveryMinutes: number;
}

const DEFAULTS: RetryConfig = { enabled: true, maxAttempts: 3, backoffMinutes: [2, 10, 30], persistEveryMinutes: 30 };

export function loadRetryConfig(): RetryConfig {
  try {
    const d = JSON.parse(readFileSync(CFG_PATH, "utf8"));
    return {
      enabled: d.enabled !== false,
      maxAttempts: Number.isFinite(d.maxAttempts) && d.maxAttempts > 0 ? Math.min(d.maxAttempts, 10) : DEFAULTS.maxAttempts,
      backoffMinutes: Array.isArray(d.backoffMinutes) && d.backoffMinutes.length ? d.backoffMinutes.map(Number).filter((n: number) => n >= 0) : DEFAULTS.backoffMinutes,
      persistEveryMinutes: Number.isFinite(d.persistEveryMinutes) && d.persistEveryMinutes >= 0 ? Math.min(d.persistEveryMinutes, 720) : DEFAULTS.persistEveryMinutes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveRetryConfig(cfg: Partial<RetryConfig>): RetryConfig {
  const cur = loadRetryConfig();
  const next: RetryConfig = {
    enabled: cfg.enabled ?? cur.enabled,
    maxAttempts: cfg.maxAttempts ?? cur.maxAttempts,
    backoffMinutes: cfg.backoffMinutes ?? cur.backoffMinutes,
    persistEveryMinutes: cfg.persistEveryMinutes ?? cur.persistEveryMinutes,
  };
  mkdirSync(dirname(CFG_PATH), { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(next, null, 2));
  return next;
}

interface TicketRetry {
  identifier?: string;
  attempts: number;       // reintentos ya consumidos
  escalated: boolean;
  nextDueAt?: number;     // epoch ms del próximo re-lanzamiento pendiente
  lastFailedAt?: string;
}
type State = Record<string, TicketRetry>;

function loadState(): State {
  try {
    const d = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return d && typeof d === "object" ? (d as State) : {};
  } catch {
    return {};
  }
}
function saveState(s: State): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    process.stderr.write(`[retry] save state: ${(e as Error).message}\n`);
  }
}

// ── Paperclip REST mínimo (mismo patrón que scheduler/paperclip-client) ───────
async function patchStatus(issueId: string, status: string): Promise<void> {
  const r = await fetch(`${PAPERCLIP}/api/issues/${issueId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ status }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`PATCH status ${r.status}`);
}
async function postComment(issueId: string, body: string): Promise<void> {
  try {
    await fetch(`${PAPERCLIP}/api/issues/${issueId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(12000),
    });
  } catch { /* best-effort */ }
}

/**
 * Registra el desenlace de un run. Reintenta failed/empty, ignora held, limpia
 * en completed. NO ejecuta el re-lanzamiento (eso lo hace processDueRetries en
 * el tick), sólo programa el nextDueAt o escala.
 */
export async function recordRunOutcome(issueId: string, identifier: string | undefined, disposition: Disposition): Promise<void> {
  if (!issueId) return;
  const state = loadState();

  if (disposition === "completed") {
    if (state[issueId]) { delete state[issueId]; saveState(state); }
    return;
  }
  if (disposition === "held") return; // policy gate — no reintentar

  const cfg = loadRetryConfig();
  if (!cfg.enabled) return;

  const st: TicketRetry = state[issueId] ?? { attempts: 0, escalated: false };
  if (identifier) st.identifier = identifier;
  st.attempts += 1;
  st.lastFailedAt = new Date().toISOString();

  if (st.attempts > cfg.maxAttempts) {
    // MODO PERSISTENTE: no se abandona nunca — se sigue reintentando cada
    // persistEveryMinutes dentro del horario laboral. Con 0 se escala y para
    // (comportamiento viejo). Sin mails ni avisos (pedido del operador).
    const ref = st.identifier || issueId;
    if (!st.escalated) {
      st.escalated = true; // visible en el dashboard como "persistente"
      await postComment(
        issueId,
        cfg.persistEveryMinutes > 0
          ? `♻️ **Reintento persistente.** El ticket falló ${cfg.maxAttempts} reintento(s) con backoff; ahora se re-lanza cada ${cfg.persistEveryMinutes} min dentro del horario laboral hasta completarse.`
          : `🚨 **Escalado a un humano.** El ticket falló ${cfg.maxAttempts} reintento(s) automático(s) y sigue sin completarse. Requiere intervención manual.`,
      );
      try { await patchStatus(issueId, "blocked"); } catch { /* ya suele estar blocked */ }
    }
    st.nextDueAt = cfg.persistEveryMinutes > 0 ? Date.now() + cfg.persistEveryMinutes * 60_000 : undefined;
    state[issueId] = st;
    saveState(state);
    process.stderr.write(
      cfg.persistEveryMinutes > 0
        ? `[retry] PERSISTENT ${ref} — next attempt in ${cfg.persistEveryMinutes}min (attempt ${st.attempts})\n`
        : `[retry] ESCALATED ${ref} after ${cfg.maxAttempts} retries\n`,
    );
    return;
  }

  const idx = Math.min(st.attempts - 1, cfg.backoffMinutes.length - 1);
  const waitMin = cfg.backoffMinutes[idx] ?? 5;
  st.nextDueAt = Date.now() + waitMin * 60_000;
  state[issueId] = st;
  saveState(state);
  process.stderr.write(`[retry] scheduled ${st.identifier || issueId} attempt ${st.attempts}/${cfg.maxAttempts} in ${waitMin}min\n`);
}

/** Llamado por el tick del scheduler: re-lanza los reintentos cuyo backoff venció. */
export async function processDueRetries(now: number = Date.now()): Promise<void> {
  const cfg = loadRetryConfig();
  if (!cfg.enabled || !KEY) return;
  // Fuera del horario laboral NO se re-lanza nada: el reintento queda vencido
  // y dispara apenas abre la ventana (del día siguiente si hace falta).
  const sched = loadWorkScheduleConfig();
  if (sched.enabled && !isWithinSchedule(sched)) return;
  const state = loadState();
  let dirty = false;
  for (const [issueId, st] of Object.entries(state)) {
    if (!st.nextDueAt || st.nextDueAt > now) continue;
    if (st.escalated && cfg.persistEveryMinutes <= 0) continue; // modo viejo: escalado = parado
    try {
      await postComment(
        issueId,
        st.escalated
          ? `♻️ Reintento persistente (cada ${cfg.persistEveryMinutes} min en horario) — re-despachando el ticket.`
          : `🔁 Reintento automático ${st.attempts}/${cfg.maxAttempts} — re-despachando el ticket.`,
      );
      await patchStatus(issueId, "todo");
      // En modo persistente ya programamos el próximo intento por si este
      // también falla; si completa, recordRunOutcome limpia el estado.
      st.nextDueAt = st.escalated ? now + cfg.persistEveryMinutes * 60_000 : undefined;
      dirty = true;
      process.stderr.write(`[retry] re-launched ${st.identifier || issueId} (attempt ${st.attempts}${st.escalated ? ", persistent" : ""})\n`);
    } catch (e) {
      // dejamos nextDueAt para reintentar en el próximo tick
      process.stderr.write(`[retry] re-launch ${issueId} failed: ${(e as Error).message}\n`);
    }
  }
  if (dirty) saveState(state);
}

/** Estado para el dashboard: pendientes de reintento + escalados. */
export function retryState(): { pending: Array<{ issueId: string } & TicketRetry>; escalated: Array<{ issueId: string } & TicketRetry> } {
  const state = loadState();
  const pending: Array<{ issueId: string } & TicketRetry> = [];
  const escalated: Array<{ issueId: string } & TicketRetry> = [];
  for (const [issueId, st] of Object.entries(state)) {
    if (st.escalated) escalated.push({ issueId, ...st });
    else if (st.nextDueAt) pending.push({ issueId, ...st });
  }
  return { pending, escalated };
}

/** Limpia el estado de un ticket (botón "resuelto" del dashboard). */
export function clearRetry(issueId: string): boolean {
  const state = loadState();
  if (!state[issueId]) return false;
  delete state[issueId];
  saveState(state);
  return true;
}
