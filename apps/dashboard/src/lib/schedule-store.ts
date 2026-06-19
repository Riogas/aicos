/**
 * Store de tareas programadas. El dashboard lo escribe; el bridge
 * (apps/paperclip-bridge/src/scheduler.ts) lo lee del mismo archivo del home
 * montado: ~/.config/aicos/schedules.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const PATH = process.env.AICOS_SCHEDULES || join(HOME, ".config", "aicos", "schedules.json");

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  agentId: string;
  enabled: boolean;
  createdAt: number;
}

export function listSchedules(): Schedule[] {
  try {
    const d = JSON.parse(readFileSync(PATH, "utf8"));
    return Array.isArray(d) ? d : (d.schedules ?? []);
  } catch {
    return [];
  }
}

function writeAll(s: Schedule[]): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify({ schedules: s }, null, 2));
}

export function upsertSchedule(input: Partial<Schedule>): Schedule {
  const all = listSchedules();
  const id = input.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const existing = all.find((x) => x.id === id);
  const sched: Schedule = {
    id,
    name: (input.name || "Tarea").slice(0, 120),
    cron: (input.cron || "0 9 * * *").trim(),
    prompt: input.prompt || "",
    agentId: input.agentId || "ceo",
    enabled: input.enabled ?? true,
    createdAt: existing?.createdAt || Date.now(),
  };
  const next = existing ? all.map((x) => (x.id === id ? sched : x)) : [...all, sched];
  writeAll(next);
  return sched;
}

export function deleteSchedule(id: string): void {
  writeAll(listSchedules().filter((x) => x.id !== id));
}
