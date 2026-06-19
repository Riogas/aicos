/**
 * Reintentos inteligentes + escalado a humano.
 *
 * Cuando un run termina FALLIDO (exit!=0) o VACÍO (exit 0 sin output útil — p.ej.
 * timeout/reconnect del CLI), el ticket se re-lanza automáticamente con backoff
 * exponencial hasta N intentos. Si agota los intentos, se ESCALA a un humano
 * (comentario + aviso Telegram fuerte) y se deja de reintentar.
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
import { notify } from "./notify.js";

const HOME = process.env.HOME || "/home/vagrant";
const CFG_PATH = process.env.AICOS_RETRY_CONFIG || join(HOME, ".config", "aicos", "retry.json");
const STATE_PATH = process.env.AICOS_RETRY_STATE || join(HOME, ".config", "aicos", "retry-state.json");
const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const KEY = process.env.PAPERCLIP_API_KEY || "";

export type Disposition = "completed" | "failed" | "empty" | "held";

export interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;       // reintentos automáticos antes de escalar
  backoffMinutes: number[];  // espera por reintento (se usa el último si faltan)
}

const DEFAULTS: RetryConfig = { enabled: true, maxAttempts: 3, backoffMinutes: [2, 10, 30] };

export function loadRetryConfig(): RetryConfig {
  try {
    const d = JSON.parse(readFileSync(CFG_PATH, "utf8"));
    return {
      enabled: d.enabled !== false,
      maxAttempts: Number.isFinite(d.maxAttempts) && d.maxAttempts > 0 ? Math.min(d.maxAttempts, 10) : DEFAULTS.maxAttempts,
      backoffMinutes: Array.isArray(d.backoffMinutes) && d.backoffMinutes.length ? d.backoffMinutes.map(Number).filter((n: number) => n >= 0) : DEFAULTS.backoffMinutes,
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
  if (st.escalated) return; // ya escalado — lo maneja un humano
  if (identifier) st.identifier = identifier;
  st.attempts += 1;
  st.lastFailedAt = new Date().toISOString();

  if (st.attempts > cfg.maxAttempts) {
    st.escalated = true;
    st.nextDueAt = undefined;
    state[issueId] = st;
    saveState(state);
    const ref = st.identifier || issueId;
    await postComment(
      issueId,
      `🚨 **Escalado a un humano.** El ticket falló ${cfg.maxAttempts} reintento(s) automático(s) y sigue sin completarse. Requiere intervención manual — revisá el último error y re-lanzalo cuando esté resuelto.`,
    );
    try { await patchStatus(issueId, "blocked"); } catch { /* ya suele estar blocked */ }
    void notify(`🚨 *${ref}* escalado tras ${cfg.maxAttempts} reintentos fallidos — necesita intervención humana.`);
    process.stderr.write(`[retry] ESCALATED ${ref} after ${cfg.maxAttempts} retries\n`);
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
  const state = loadState();
  let dirty = false;
  for (const [issueId, st] of Object.entries(state)) {
    if (st.escalated || !st.nextDueAt || st.nextDueAt > now) continue;
    try {
      await postComment(issueId, `🔁 Reintento automático ${st.attempts}/${cfg.maxAttempts} — re-despachando el ticket.`);
      await patchStatus(issueId, "todo");
      st.nextDueAt = undefined;
      dirty = true;
      process.stderr.write(`[retry] re-launched ${st.identifier || issueId} (attempt ${st.attempts})\n`);
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
