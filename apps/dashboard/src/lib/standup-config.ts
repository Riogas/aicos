/** Config + último standup (mismo home montado que lee/escribe el bridge). */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const CFG = process.env.AICOS_STANDUP_CONFIG || join(HOME, ".config", "aicos", "standup.json");
const LAST = join(HOME, ".config", "aicos", "standup-last.json");

export interface StandupConfig { enabled: boolean; time: string; lastSentDate?: string }

export function readConfig(): StandupConfig {
  try { return { enabled: false, time: "18:00", ...JSON.parse(readFileSync(CFG, "utf8")) }; }
  catch { return { enabled: false, time: "18:00" }; }
}
export function writeConfig(c: Partial<StandupConfig>): StandupConfig {
  const cur = readConfig();
  const next: StandupConfig = { ...cur, enabled: c.enabled ?? cur.enabled, time: (c.time || cur.time).trim() };
  mkdirSync(dirname(CFG), { recursive: true });
  writeFileSync(CFG, JSON.stringify(next, null, 2));
  return next;
}
export function readLast(): unknown {
  try { return JSON.parse(readFileSync(LAST, "utf8")); } catch { return null; }
}
