/**
 * Daily standup del CEO. Junta la actividad del día en Paperclip (tickets
 * completados/bloqueados/en curso, por proyecto), arma un digest, el CEO
 * (claude) escribe un resumen ejecutivo breve, y se manda por Telegram +
 * se guarda en ~/.config/aicos/standup-last.json para el dashboard.
 *
 * Config en ~/.config/aicos/standup.json: { enabled, time:"18:00", lastSentDate }
 * El daily check lo dispara el scheduler a la hora configurada.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { notify } from "./notify.js";

const HOME = process.env.HOME || "/home/vagrant";
const CFG_PATH = process.env.AICOS_STANDUP_CONFIG || join(HOME, ".config", "aicos", "standup.json");
const LAST_PATH = join(HOME, ".config", "aicos", "standup-last.json");
const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const KEY = process.env.PAPERCLIP_API_KEY || "";
const COMPANY = process.env.AICOS_COMPANY_ID || "";
const CONTAINER = process.env.AICOS_AGENT_CONTAINER || "aicos-paperclip";
const AGENT_UID = process.env.AICOS_AGENT_UID || "1000:1000";

interface StandupConfig { enabled: boolean; time: string; lastSentDate?: string }

export function loadConfig(): StandupConfig {
  try { return { enabled: false, time: "18:00", ...JSON.parse(readFileSync(CFG_PATH, "utf8")) }; }
  catch { return { enabled: false, time: "18:00" }; }
}
function saveConfig(c: StandupConfig): void {
  mkdirSync(dirname(CFG_PATH), { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(c, null, 2));
}

async function pcGet(path: string): Promise<any> {
  try {
    const r = await fetch(`${PAPERCLIP}${path}`, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
function asArray(d: any): any[] { return Array.isArray(d) ? d : (d?.items ?? d?.agents ?? []); }

function isToday(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso); const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

async function gather() {
  const [done, blocked, inProg, agents, projects] = await Promise.all([
    pcGet(`/api/companies/${COMPANY}/issues?status=done`).then(asArray),
    pcGet(`/api/companies/${COMPANY}/issues?status=blocked`).then(asArray),
    pcGet(`/api/companies/${COMPANY}/issues?status=in_progress`).then(asArray),
    pcGet(`/api/companies/${COMPANY}/agents`).then(asArray),
    pcGet(`/api/companies/${COMPANY}/projects`).then(asArray),
  ]);
  const agentName: Record<string, string> = {}; for (const a of agents) agentName[a.id] = a.name;
  const projName: Record<string, string> = {}; for (const p of projects) projName[p.id] = p.name;
  const slim = (i: any) => ({
    id: i.identifier, title: i.title,
    agent: i.assigneeAgentId ? (agentName[i.assigneeAgentId] || "—") : "—",
    project: i.projectId ? (projName[i.projectId] || "—") : "—",
  });
  return {
    doneToday: done.filter((i: any) => isToday(i.completedAt || i.updatedAt)).map(slim),
    blocked: blocked.map(slim),
    inProgress: inProg.map(slim),
  };
}

function buildDigest(a: Awaited<ReturnType<typeof gather>>, dateStr: string): string {
  const lines: string[] = [`📊 *Standup AICOS — ${dateStr}*`, ""];
  lines.push(`✅ *Completadas hoy:* ${a.doneToday.length}`);
  for (const i of a.doneToday.slice(0, 12)) lines.push(`   • ${i.id} ${i.title} — ${i.agent}${i.project !== "—" ? ` (${i.project})` : ""}`);
  lines.push(`🔄 *En curso:* ${a.inProgress.length}`);
  for (const i of a.inProgress.slice(0, 8)) lines.push(`   • ${i.id} ${i.title} — ${i.agent}`);
  lines.push(`⚠️ *Bloqueadas:* ${a.blocked.length}`);
  for (const i of a.blocked.slice(0, 8)) lines.push(`   • ${i.id} ${i.title}`);
  return lines.join("\n");
}

/** El CEO (claude) escribe un resumen ejecutivo a partir del digest. Best-effort. */
async function ceoNarrative(digest: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const prompt =
        "Sos el CEO de la empresa. Esta es la actividad de hoy del equipo de agentes:\n\n" +
        digest +
        "\n\nEscribí un standup ejecutivo MUY breve (máx 4 líneas): 2 highlights, qué está trabado, y qué priorizar mañana. Tono directo, sin saludos.";
      const proc = spawn("docker", [
        "exec", "-i", "-u", AGENT_UID, "-e", `HOME=${HOME}`, "-e", "IS_SANDBOX=1",
        CONTAINER, "claude", "-p", prompt, "--model", "sonnet", "--dangerously-skip-permissions",
      ], { stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
      let out = "";
      proc.stdout.on("data", (c) => { out += c.toString("utf8"); });
      proc.on("error", () => resolve(""));
      proc.on("exit", (code) => resolve(code === 0 ? out.trim() : ""));
    } catch { resolve(""); }
  });
}

export async function runStandup(manual = false): Promise<{ ok: boolean; text: string }> {
  if (!COMPANY || !KEY) return { ok: false, text: "sin COMPANY/KEY" };
  const now = new Date();
  const dateStr = now.toLocaleDateString("es-UY", { weekday: "long", day: "numeric", month: "long" });
  const a = await gather();
  const digest = buildDigest(a, dateStr);
  const narrative = await ceoNarrative(digest);
  const text = narrative ? `${narrative}\n\n${digest}` : digest;
  await notify(text);
  try {
    mkdirSync(dirname(LAST_PATH), { recursive: true });
    writeFileSync(LAST_PATH, JSON.stringify({ at: now.toISOString(), text, manual }, null, 2));
  } catch { /* */ }
  if (!manual) { const c = loadConfig(); c.lastSentDate = now.toISOString().slice(0, 10); saveConfig(c); }
  process.stderr.write(`[standup] enviado (${manual ? "manual" : "auto"}) — ${a.doneToday.length} done\n`);
  return { ok: true, text };
}

export function lastStandup(): unknown {
  try { return JSON.parse(readFileSync(LAST_PATH, "utf8")); } catch { return null; }
}

/** Chequeo diario — lo llama el scheduler cada tick. */
export async function standupTick(now: Date): Promise<void> {
  const c = loadConfig();
  if (!c.enabled) return;
  const [h, m] = c.time.split(":").map((x) => parseInt(x, 10));
  if (now.getHours() !== h || now.getMinutes() !== m) return;
  if (c.lastSentDate === now.toISOString().slice(0, 10)) return; // ya se mandó hoy
  await runStandup(false);
}
