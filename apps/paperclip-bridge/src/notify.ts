/**
 * Notificaciones salientes por Telegram.
 *
 * Lee la config de `~/.config/aicos/notifications.json` (la edita el dashboard
 * en Ajustes). El home del host está montado en el container (Path A), así que
 * tanto el bridge host como el bridge en-container leen el mismo archivo.
 *
 * Config:
 *   { "enabled": true, "botToken": "123:ABC",
 *     "defaultChatId": "123456",            // fallback hasta tener auth por usuario
 *     "users": { "jgomez": "123456" } }     // username (post-auth) → chatId
 *
 * Nunca rompe el run: cualquier error se traga.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/home/vagrant";
const CONFIG_PATH = process.env.AICOS_NOTIFY_CONFIG || join(HOME, ".config", "aicos", "notifications.json");

interface NotifyConfig {
  enabled?: boolean;
  botToken?: string;
  defaultChatId?: string;
  users?: Record<string, string>;
}

function loadConfig(): NotifyConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as NotifyConfig;
  } catch {
    return null;
  }
}

/**
 * Envía una notificación. `username` (cuando exista auth) rutea al chatId del
 * usuario; si no hay, cae al defaultChatId.
 */
export async function notify(text: string, opts?: { username?: string }): Promise<void> {
  const cfg = loadConfig();
  if (!cfg || cfg.enabled === false || !cfg.botToken) return;
  const chatId =
    (opts?.username && cfg.users?.[opts.username]) || cfg.defaultChatId;
  if (!chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    /* las notificaciones nunca rompen el run */
  }
}
