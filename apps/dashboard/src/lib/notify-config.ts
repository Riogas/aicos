/**
 * Config de notificaciones (Telegram) — leída/escrita por el dashboard y leída
 * por el bridge (apps/paperclip-bridge/src/notify.ts) en el MISMO archivo del
 * home montado: ~/.config/aicos/notifications.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const CONFIG_PATH = process.env.AICOS_NOTIFY_CONFIG || join(HOME, ".config", "aicos", "notifications.json");

export interface NotifyConfig {
  enabled: boolean;
  botToken: string;
  defaultChatId: string;
  users: Record<string, string>; // username (post-auth) → chatId
}

const EMPTY: NotifyConfig = { enabled: false, botToken: "", defaultChatId: "", users: {} };

export function readConfig(): NotifyConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...EMPTY, ...raw, users: raw.users || {} };
  } catch {
    return { ...EMPTY };
  }
}

export function writeConfig(c: NotifyConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

export function maskToken(t: string): string {
  if (!t) return "";
  return t.length <= 8 ? "••••" : `${t.slice(0, 4)}…${t.slice(-4)}`;
}
