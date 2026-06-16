/**
 * Trae el "resultado final" de un run: el último comentario que el agente dejó
 * en su issue de Paperclip (el reporte de cierre con lo que analizó/hizo).
 *
 * El dashboard tiene PAPERCLIP_API_URL + PAPERCLIP_API_KEY (la key del agente
 * Hermes) en su env (ver dashboard.env). Resolvemos el issue por su identifier
 * (ej "RIO-113") y devolvemos sus comentarios de agente más recientes.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const KEY = process.env.PAPERCLIP_API_KEY || "";

interface PcComment {
  id?: string;
  body?: string;
  authorAgentId?: string | null;
  author_agent_id?: string | null;
  createdAt?: string;
  created_at?: string;
}

async function pc<T>(path: string): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${PAPERCLIP}${path}`, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const ticket = new URL(req.url).searchParams.get("ticket")?.trim();
  if (!ticket) {
    return NextResponse.json({ error: "missing ?ticket" }, { status: 400 });
  }

  // 1) resolver identifier → issue (id real)
  const issue = await pc<{ id?: string; identifier?: string; title?: string; status?: string }>(
    `/api/issues/${encodeURIComponent(ticket)}`,
  );
  if (!issue?.id) {
    return NextResponse.json({ ok: false, error: "issue no encontrado" }, { status: 404 });
  }

  // 2) comentarios del issue
  const raw = await pc<PcComment[] | { comments?: PcComment[] }>(
    `/api/issues/${issue.id}/comments`,
  );
  const comments: PcComment[] = Array.isArray(raw) ? raw : (raw?.comments ?? []);

  const norm = comments.map((c) => ({
    body: c.body ?? "",
    authorAgentId: c.authorAgentId ?? c.author_agent_id ?? null,
    createdAt: c.createdAt ?? c.created_at ?? "",
    isAgent: Boolean(c.authorAgentId ?? c.author_agent_id),
  }));

  // El "resultado final" = el comentario de agente más reciente que NO es un
  // mensaje de sistema/recovery de Paperclip.
  const agentComments = norm
    .filter((c) => c.isAgent && !/^Paperclip automatically/i.test(c.body))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return NextResponse.json({
    ok: true,
    ticket,
    issue: { id: issue.id, title: issue.title ?? null, status: issue.status ?? null },
    result: agentComments[0]?.body ?? null,
    comments: agentComments.slice(0, 5),
  });
}
