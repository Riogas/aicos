/**
 * 4-layer memory system en Qdrant (L4).
 *
 * Modelo:
 *   - 4 collections separadas, una por scope:
 *       aicos_agent_memory    — recuerdos por agente (filter por registryId)
 *       aicos_project_memory  — decisiones/historia por proyecto (filter por projectId)
 *       aicos_company_memory  — hechos de la empresa (no filter)
 *       aicos_market_memory   — conocimiento del mercado/competidores (no filter)
 *   - Cada punto tiene payload {scope, registryId?, ticketId?, projectId?, ts, text, summary, tags?}
 *   - Embeddings via OpenAI text-embedding-3-small (1536 dims, barato)
 *
 * Diseno tolerante a fallos: si OPENAI_API_KEY no esta o Qdrant no responde,
 * loggea warning y sigue (no rompe el run del agente).
 */

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIM = 1536;

export type MemoryScope = "agent" | "project" | "company" | "market";

const COLLECTIONS: Record<MemoryScope, string> = {
  agent: process.env.AICOS_AGENT_MEMORY_COLLECTION ?? "aicos_agent_memory",
  project: process.env.AICOS_PROJECT_MEMORY_COLLECTION ?? "aicos_project_memory",
  company: process.env.AICOS_COMPANY_MEMORY_COLLECTION ?? "aicos_company_memory",
  market: process.env.AICOS_MARKET_MEMORY_COLLECTION ?? "aicos_market_memory",
};

const collectionEnsured = new Map<MemoryScope, boolean>();

export interface MemoryEntry {
  scope: MemoryScope;
  registryId?: string;        // required for scope=agent
  ticketId?: string;
  ticketIdentifier?: string;
  projectId?: string;          // required for scope=project
  text: string;
  summary?: string;
  tags?: string[];
}

export interface RetrievedMemory {
  scope: MemoryScope;
  score: number;
  ticketIdentifier?: string;
  projectId?: string;
  registryId?: string;
  summary: string;
  ts: string;
  tags?: string[];
}

async function embed(text: string): Promise<number[] | null> {
  if (!OPENAI_KEY) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: text.slice(0, 8000),
      }),
    });
    if (!r.ok) {
      process.stderr.write(`[memory] embed fail: ${r.status} ${await r.text().catch(() => "")}\n`);
      return null;
    }
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    return j.data?.[0]?.embedding ?? null;
  } catch (e) {
    process.stderr.write(`[memory] embed error: ${(e as Error).message}\n`);
    return null;
  }
}

async function ensureCollection(scope: MemoryScope): Promise<boolean> {
  if (collectionEnsured.get(scope)) return true;
  const collection = COLLECTIONS[scope];
  try {
    const head = await fetch(`${QDRANT_URL}/collections/${collection}`);
    if (head.ok) {
      collectionEnsured.set(scope, true);
      return true;
    }
    if (head.status !== 404) {
      process.stderr.write(`[memory] qdrant head ${collection}: ${head.status}\n`);
      return false;
    }
    const create = await fetch(`${QDRANT_URL}/collections/${collection}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: EMBED_DIM, distance: "Cosine" },
      }),
    });
    if (!create.ok) {
      process.stderr.write(
        `[memory] qdrant create ${collection}: ${create.status} ${await create.text().catch(() => "")}\n`,
      );
      return false;
    }
    collectionEnsured.set(scope, true);
    return true;
  } catch (e) {
    process.stderr.write(`[memory] qdrant ensure ${scope}: ${(e as Error).message}\n`);
    return false;
  }
}

function pointId(scope: MemoryScope, key: string): string {
  // UUID estable per scope+key — idempotent stores.
  const seed = `${scope}:${key}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  const c = ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0");
  const d = (Math.imul(h1, h2) >>> 0).toString(16).padStart(8, "0");
  return `${a.slice(0, 8)}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${c.slice(0, 3)}-${c.slice(3, 8)}${d}`;
}

function dedupKeyFor(entry: MemoryEntry): string {
  switch (entry.scope) {
    case "agent":
      return `${entry.registryId ?? "?"}:${entry.ticketId ?? entry.text.slice(0, 60)}`;
    case "project":
      return `${entry.projectId ?? "?"}:${entry.ticketId ?? entry.text.slice(0, 60)}`;
    case "company":
    case "market":
      // Company/Market entries dedupe by text content (semantic stability)
      return entry.text.slice(0, 200);
  }
}

/**
 * Stores (upsert) one memory entry into the appropriate collection.
 * Returns true if stored, false on any failure (logs internally).
 */
export async function storeMemory(entry: MemoryEntry): Promise<boolean> {
  if (!OPENAI_KEY) return false;
  if (entry.scope === "agent" && !entry.registryId) {
    process.stderr.write(`[memory] agent scope needs registryId\n`);
    return false;
  }
  if (entry.scope === "project" && !entry.projectId) {
    process.stderr.write(`[memory] project scope needs projectId\n`);
    return false;
  }
  const ok = await ensureCollection(entry.scope);
  if (!ok) return false;

  const vector = await embed(entry.text);
  if (!vector) return false;

  const id = pointId(entry.scope, dedupKeyFor(entry));
  const summary = entry.summary ?? entry.text.replace(/\s+/g, " ").trim().slice(0, 400);
  const collection = COLLECTIONS[entry.scope];

  try {
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          {
            id,
            vector,
            payload: {
              scope: entry.scope,
              registryId: entry.registryId,
              ticketId: entry.ticketId,
              ticketIdentifier: entry.ticketIdentifier,
              projectId: entry.projectId,
              ts: new Date().toISOString(),
              text: entry.text.slice(0, 4000),
              summary,
              tags: entry.tags,
            },
          },
        ],
      }),
    });
    if (!r.ok) {
      process.stderr.write(
        `[memory] store ${entry.scope} fail: ${r.status} ${await r.text().catch(() => "")}\n`,
      );
      return false;
    }
    return true;
  } catch (e) {
    process.stderr.write(`[memory] store ${entry.scope} error: ${(e as Error).message}\n`);
    return false;
  }
}

interface RetrieveOpts {
  registryId?: string;
  projectId?: string;
  limit?: number;
}

/**
 * Retrieves top-K memories from a SINGLE scope filtered by registryId/projectId.
 */
export async function retrieveFromScope(
  scope: MemoryScope,
  query: string,
  opts: RetrieveOpts = {},
): Promise<RetrievedMemory[]> {
  if (!OPENAI_KEY) return [];
  const ok = await ensureCollection(scope);
  if (!ok) return [];
  const vector = await embed(query);
  if (!vector) return [];

  const must: Array<Record<string, unknown>> = [];
  if (scope === "agent" && opts.registryId) {
    must.push({ key: "registryId", match: { value: opts.registryId } });
  }
  if (scope === "project" && opts.projectId) {
    must.push({ key: "projectId", match: { value: opts.projectId } });
  }
  // company / market: no filter — global pool

  try {
    const r = await fetch(`${QDRANT_URL}/collections/${COLLECTIONS[scope]}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: opts.limit ?? 3,
        with_payload: true,
        ...(must.length > 0 ? { filter: { must } } : {}),
      }),
    });
    if (!r.ok) {
      process.stderr.write(
        `[memory] search ${scope} fail: ${r.status} ${await r.text().catch(() => "")}\n`,
      );
      return [];
    }
    const j = (await r.json()) as {
      result: { score: number; payload: Record<string, unknown> }[];
    };
    return (j.result ?? []).map((p) => ({
      scope,
      score: p.score,
      ticketIdentifier: p.payload.ticketIdentifier as string | undefined,
      projectId: p.payload.projectId as string | undefined,
      registryId: p.payload.registryId as string | undefined,
      summary: (p.payload.summary as string) ?? (p.payload.text as string) ?? "",
      ts: (p.payload.ts as string) ?? "",
      tags: p.payload.tags as string[] | undefined,
    }));
  } catch (e) {
    process.stderr.write(`[memory] search ${scope} error: ${(e as Error).message}\n`);
    return [];
  }
}

/**
 * Convenience: retrieves from ALL applicable scopes in parallel + merges into
 * a context pack ordered by score. Caller decides limits per scope.
 */
export async function retrieveAllScopes(
  query: string,
  opts: {
    registryId?: string;
    projectId?: string;
    perScopeLimit?: number;
  } = {},
): Promise<RetrievedMemory[]> {
  const limit = opts.perScopeLimit ?? 2;
  const tasks: Array<Promise<RetrievedMemory[]>> = [];
  if (opts.registryId) {
    tasks.push(retrieveFromScope("agent", query, { registryId: opts.registryId, limit }));
  }
  if (opts.projectId) {
    tasks.push(retrieveFromScope("project", query, { projectId: opts.projectId, limit }));
  }
  tasks.push(retrieveFromScope("company", query, { limit }));
  tasks.push(retrieveFromScope("market", query, { limit }));
  const results = await Promise.all(tasks);
  return results.flat().sort((a, b) => b.score - a.score);
}

/**
 * Backward compat: original retrieveRelatedMemories targeted agent scope only.
 * Kept so existing call sites keep working without refactor.
 */
export async function retrieveRelatedMemories(
  registryId: string,
  query: string,
  opts: { projectId?: string; limit?: number } = {},
): Promise<RetrievedMemory[]> {
  return retrieveFromScope("agent", query, { registryId, limit: opts.limit });
}

/**
 * Renders memories grouped by scope into a prompt-friendly context block.
 */
export function formatMemoriesForPrompt(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return "";
  const byScope: Record<MemoryScope, RetrievedMemory[]> = {
    agent: [],
    project: [],
    company: [],
    market: [],
  };
  for (const m of memories) byScope[m.scope].push(m);

  const lines: string[] = [];
  const labels: Record<MemoryScope, string> = {
    agent: "TUS RUNS PREVIOS (este agente)",
    project: "HISTORIA DEL PROYECTO (decisiones, arquitectura, gotchas)",
    company: "HECHOS DE LA EMPRESA (politicas, brand, restricciones)",
    market: "CONOCIMIENTO DEL MERCADO (competidores, tendencias)",
  };

  for (const scope of ["project", "agent", "company", "market"] as MemoryScope[]) {
    const items = byScope[scope];
    if (items.length === 0) continue;
    lines.push(`# MEMORIA · ${labels[scope]} (top ${items.length})`);
    for (const m of items) {
      const head = m.ticketIdentifier ?? m.registryId ?? m.projectId ?? "?";
      lines.push(`## ${head} (score ${m.score.toFixed(2)}, ${m.ts.slice(0, 10)})`);
      lines.push(m.summary);
      lines.push("");
    }
  }
  return lines.join("\n");
}
