/**
 * Scheduler de tareas programadas/recurrentes.
 *
 * Lee ~/.config/aicos/schedules.json (lo edita el dashboard) y, en cada tick,
 * dispara los schedules cuyo cron matchea el minuto actual: crea un issue en
 * Paperclip (el `prompt` como descripción) asignado al agente elegido, en
 * estado `todo` → Paperclip lo despacha y el agente lo ejecuta.
 *
 * Corre SOLO en el bridge host (--serve), no en los process-adapter (per-run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/home/vagrant";
const SCHED_PATH = process.env.AICOS_SCHEDULES || join(HOME, ".config", "aicos", "schedules.json");
const ROOT = process.env.AICOS_ROOT || join(HOME, "aicos");
const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const KEY = process.env.PAPERCLIP_API_KEY || "";
const COMPANY = process.env.AICOS_COMPANY_ID || "";

interface Schedule {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  agentId: string;
  enabled: boolean;
}

function loadSchedules(): Schedule[] {
  try {
    const d = JSON.parse(readFileSync(SCHED_PATH, "utf8"));
    return Array.isArray(d) ? d : (d.schedules ?? []);
  } catch {
    return [];
  }
}

function agentMap(): Record<string, string> {
  try {
    const reg = JSON.parse(readFileSync(join(ROOT, "registry", "agents.json"), "utf8")) as {
      agents?: { id: string; paperclipAgentId?: string | null }[];
    };
    const m: Record<string, string> = {};
    for (const a of reg.agents ?? []) if (a.paperclipAgentId) m[a.id] = a.paperclipAgentId;
    return m;
  } catch {
    return {};
  }
}

// ── matcher de cron de 5 campos: minuto hora díaMes mes díaSemana ─────────────
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const step = part.includes("/") ? parseInt(part.split("/")[1], 10) : 1;
    const rangePart = part.split("/")[0];
    let lo = min, hi = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map((n) => parseInt(n, 10));
        lo = a; hi = b;
      } else {
        lo = hi = parseInt(rangePart, 10);
      }
    }
    if (Number.isNaN(lo)) continue;
    if (value < lo || value > hi) continue;
    if ((value - lo) % (step || 1) === 0) return true;
  }
  return false;
}

export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const dow = d.getDay(); // 0=domingo
  return (
    fieldMatches(f[0], d.getMinutes(), 0, 59) &&
    fieldMatches(f[1], d.getHours(), 0, 23) &&
    fieldMatches(f[2], d.getDate(), 1, 31) &&
    fieldMatches(f[3], d.getMonth() + 1, 1, 12) &&
    (fieldMatches(f[4], dow, 0, 6) || (dow === 0 && fieldMatches(f[4], 7, 0, 7)))
  );
}

async function fire(s: Schedule): Promise<void> {
  const agents = agentMap();
  const assignee = agents[s.agentId] || agents["ceo"];
  const body: Record<string, unknown> = {
    title: `[programada] ${s.name}`,
    description: s.prompt,
    status: "todo",
    priority: "medium",
  };
  if (assignee) body.assigneeAgentId = assignee;
  const r = await fetch(`${PAPERCLIP}/api/companies/${COMPANY}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`createIssue HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`);
}

const lastFired = new Map<string, string>(); // id → "YYYY-MM-DDTHH:mm"

export function startScheduler(): void {
  if (!COMPANY || !KEY) {
    process.stderr.write("[scheduler] sin COMPANY/KEY — deshabilitado\n");
    return;
  }
  const tick = async () => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    for (const s of loadSchedules()) {
      if (!s.enabled || !s.cron || !s.prompt) continue;
      if (lastFired.get(s.id) === minuteKey) continue;
      try {
        if (cronMatches(s.cron, now)) {
          lastFired.set(s.id, minuteKey);
          await fire(s);
          process.stderr.write(`[scheduler] disparada "${s.name}" (${s.id})\n`);
        }
      } catch (e) {
        process.stderr.write(`[scheduler] fire ${s.id}: ${(e as Error).message}\n`);
      }
    }
  };
  setInterval(tick, 30_000);
  void tick();
  process.stderr.write(`[scheduler] iniciado — ${SCHED_PATH}\n`);
}
