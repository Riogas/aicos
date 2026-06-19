/**
 * Base de conocimiento (RAG sobre docs de la empresa).
 *
 * Ingiere documentos (texto pegado, archivos de texto/markdown, etc.), los
 * trocea en chunks con solapamiento, los embebe y los guarda en la collection
 * `aicos_knowledge` (scope=knowledge). Como `retrieveAllScopes` ya consulta ese
 * scope, los agentes Y el Strategy Room reciben el conocimiento automáticamente.
 *
 * Gestión por documento (docId): listar y borrar todos los chunks de un doc.
 */
import { storeMemory, qdrantTarget, embedderReady } from "./memory.js";

export interface KnowledgeDoc {
  docId: string;
  title: string;
  source?: string;
  tags?: string[];
  chunks: number;
  chars: number;
  ts: string;
}

/** Trocea texto en chunks ~maxChars con overlap, cortando en límites de párrafo/frase. */
export function chunkText(text: string, maxChars = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  // Partimos por párrafos y acumulamos hasta maxChars.
  const paras = clean.split(/\n\n+/);
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (const para of paras) {
    if (para.length > maxChars) {
      // Párrafo gigante: cortar por frases.
      flush();
      const sentences = para.match(/[^.!?\n]+[.!?]?/g) ?? [para];
      let sc = "";
      for (const s of sentences) {
        if ((sc + s).length > maxChars) { if (sc.trim()) chunks.push(sc.trim()); sc = s; }
        else sc += s;
      }
      if (sc.trim()) chunks.push(sc.trim());
      continue;
    }
    if ((cur + "\n\n" + para).length > maxChars) flush();
    cur += (cur ? "\n\n" : "") + para;
  }
  flush();

  // Solapamiento: prefijamos cada chunk con la cola del anterior (continuidad).
  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-overlap);
      chunks[i] = tail + " … " + chunks[i];
    }
  }
  return chunks;
}

const slug = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc";

/** Ingiere un documento: chunk → embed → store. Devuelve metadata del doc. */
export async function ingestDocument(input: {
  title: string;
  text: string;
  source?: string;
  tags?: string[];
  docId?: string;
}): Promise<{ ok: boolean; docId: string; chunks: number; stored: number; error?: string }> {
  if (!embedderReady) return { ok: false, docId: "", chunks: 0, stored: 0, error: "no hay embedder configurado (AICOS_EMBEDDINGS_URL)" };
  const title = (input.title || input.source || "Documento").trim();
  const text = (input.text || "").trim();
  if (!text) return { ok: false, docId: "", chunks: 0, stored: 0, error: "documento vacío" };

  const docId = input.docId || `${slug(title)}-${idSuffix(title + text.length)}`;
  const pieces = chunkText(text);
  let stored = 0;
  // Secuencial para no saturar el embedder local (CPU).
  for (let i = 0; i < pieces.length; i++) {
    const ok = await storeMemory({
      scope: "knowledge",
      docId,
      chunkIndex: i,
      source: title,
      text: pieces[i],
      tags: input.tags,
    });
    if (ok) stored++;
  }
  return { ok: stored > 0, docId, chunks: pieces.length, stored, error: stored === 0 ? "no se pudo guardar ningún chunk" : undefined };
}

/** UUID-ish corto determinístico para el docId (sin Date.now/Math.random aquí). */
function idSuffix(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).slice(0, 6);
}

/** Lista los documentos ingeridos (agrupando chunks por docId vía scroll). */
export async function listDocuments(): Promise<KnowledgeDoc[]> {
  const { url, collection } = qdrantTarget("knowledge");
  const docs = new Map<string, KnowledgeDoc>();
  let offset: unknown = undefined;
  try {
    for (let page = 0; page < 50; page++) {
      const r = await fetch(`${url}/collections/${collection}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 256, with_payload: true, with_vector: false, ...(offset ? { offset } : {}) }),
      });
      if (!r.ok) {
        if (r.status === 404) return []; // collection aún no existe
        return [...docs.values()];
      }
      const j = (await r.json()) as { result?: { points?: { payload?: Record<string, unknown> }[]; next_page_offset?: unknown } };
      const points = j.result?.points ?? [];
      for (const p of points) {
        const pl = p.payload ?? {};
        const docId = (pl.docId as string) || "?";
        const d = docs.get(docId) ?? {
          docId,
          title: (pl.source as string) || docId,
          source: pl.source as string | undefined,
          tags: pl.tags as string[] | undefined,
          chunks: 0,
          chars: 0,
          ts: (pl.ts as string) || "",
        };
        d.chunks++;
        d.chars += ((pl.text as string) || "").length;
        if ((pl.ts as string) && (pl.ts as string) > d.ts) d.ts = pl.ts as string;
        docs.set(docId, d);
      }
      offset = j.result?.next_page_offset;
      if (!offset) break;
    }
  } catch {
    /* devolvemos lo que haya */
  }
  return [...docs.values()].sort((a, b) => (b.ts > a.ts ? 1 : -1));
}

/** Borra todos los chunks de un documento por docId. */
export async function deleteDocument(docId: string): Promise<{ ok: boolean; error?: string }> {
  if (!docId) return { ok: false, error: "falta docId" };
  const { url, collection } = qdrantTarget("knowledge");
  try {
    const r = await fetch(`${url}/collections/${collection}/points/delete?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { must: [{ key: "docId", match: { value: docId } }] } }),
    });
    if (!r.ok) return { ok: false, error: `qdrant ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
