/**
 * Persistencia de conversaciones de la Strategy Room (estilo ChatGPT).
 *
 * Cada conversación se guarda como un JSON en un dir de datos del host. Retención
 * máxima 1 semana: el listado borra todo lo que tenga > 7 días. Sin DB — un
 * archivo por charla alcanza y sobra para una superficie de operador.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const DIR = process.env.STUDIO_DATA_DIR || join(HOME, ".local", "share", "aicos", "studio");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredConversation {
  id: string;
  title: string;
  interlocutor: string;
  model: string;
  sessionId: string | null;
  messages: unknown[];
  createdAt: number;
  updatedAt: number;
}
export interface ConversationMeta {
  id: string;
  title: string;
  interlocutor: string;
  updatedAt: number;
}

function ensureDir() { try { mkdirSync(DIR, { recursive: true }); } catch { /* noop */ } }
// Guard contra path traversal: solo ids alfanuméricos/-/_.
function validId(id: string): boolean { return /^[A-Za-z0-9_-]{4,100}$/.test(id); }

export function cleanupOld(): void {
  ensureDir();
  const now = Date.now();
  let files: string[] = [];
  try { files = readdirSync(DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(DIR, f);
    try {
      const c = JSON.parse(readFileSync(p, "utf8")) as StoredConversation;
      const t = c.updatedAt || statSync(p).mtimeMs;
      if (now - t > WEEK_MS) rmSync(p, { force: true });
    } catch {
      // archivo corrupto: si es viejo por mtime, borralo
      try { if (now - statSync(p).mtimeMs > WEEK_MS) rmSync(p, { force: true }); } catch { /* noop */ }
    }
  }
}

export function listConversations(): ConversationMeta[] {
  cleanupOld();
  const out: ConversationMeta[] = [];
  let files: string[] = [];
  try { files = readdirSync(DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(readFileSync(join(DIR, f), "utf8")) as StoredConversation;
      if (!c.messages || (c.messages as unknown[]).length === 0) continue;
      out.push({ id: c.id, title: c.title || "Sin título", interlocutor: c.interlocutor, updatedAt: c.updatedAt || 0 });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function getConversation(id: string): StoredConversation | null {
  if (!validId(id)) return null;
  try { return JSON.parse(readFileSync(join(DIR, id + ".json"), "utf8")) as StoredConversation; }
  catch { return null; }
}

export function saveConversation(c: StoredConversation): boolean {
  if (!c?.id || !validId(c.id)) return false;
  ensureDir();
  c.updatedAt = Date.now();
  if (!c.createdAt) c.createdAt = c.updatedAt;
  try { writeFileSync(join(DIR, c.id + ".json"), JSON.stringify(c)); return true; }
  catch { return false; }
}

export function deleteConversation(id: string): boolean {
  if (!validId(id)) return false;
  try { rmSync(join(DIR, id + ".json"), { force: true }); return true; }
  catch { return false; }
}
