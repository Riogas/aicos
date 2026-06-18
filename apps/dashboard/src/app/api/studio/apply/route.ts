/**
 * POST /api/studio/apply — materializa una spec de la Strategy Room en Paperclip.
 *
 * Crea (opcional) un proyecto nuevo + un issue "goal" padre (asignado al CEO) +
 * las tareas/subtareas como hijos, en estado `backlog` (el operador las arranca
 * después). Resuelve cada agentId (id de registry) → paperclipAgentId, y las
 * dependencias (`dependsOn` por ref) → blockedByIssueIds.
 *
 * Body: { spec: AicosSpec }
 * Respuesta: { ok, projectId?, parent:{id,identifier}, created:[{ref,identifier,id,agentId}] , warnings:[] }
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
const COMPANY = process.env.AICOS_COMPANY_ID || "";
const TOKEN = process.env.PAPERCLIP_BOARD_TOKEN || process.env.PAPERCLIP_API_KEY || "";
const HOST_HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const REPO = process.env.AICOS_ROOT || `${HOST_HOME}/aicos`;
const DEFAULT_PROJECT = process.env.AICOS_DEFAULT_PROJECT_ID || "";

interface SpecTask {
  ref?: string;
  title: string;
  description?: string;
  agentId?: string;
  dependsOn?: string[];
  subtasks?: SpecTask[];
}
interface AicosSpec {
  title?: string;
  summary?: string;
  newProject?: { name: string; description?: string } | null;
  tasks?: SpecTask[];
}

function agentIdMap(): Record<string, string> {
  try {
    const reg = JSON.parse(readFileSync(join(REPO, "registry", "agents.json"), "utf8")) as {
      agents?: { id: string; paperclipAgentId?: string | null }[];
    };
    const m: Record<string, string> = {};
    for (const a of reg.agents || []) if (a.paperclipAgentId) m[a.id] = a.paperclipAgentId;
    return m;
  } catch {
    return {};
  }
}

async function pc(method: string, path: string, body?: unknown): Promise<{ code: number; data: any }> {
  const res = await fetch(PAPERCLIP + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { code: res.status, data };
}

// Aplana tasks+subtasks a una lista con parentRef, y ordena topológicamente por dependsOn.
function flatten(tasks: SpecTask[]): { node: SpecTask; parentRef: string | null }[] {
  const out: { node: SpecTask; parentRef: string | null }[] = [];
  const walk = (t: SpecTask, parentRef: string | null) => {
    out.push({ node: t, parentRef });
    for (const s of t.subtasks || []) walk(s, t.ref || null);
  };
  for (const t of tasks) walk(t, null);
  return out;
}

function topoSort(items: { node: SpecTask; parentRef: string | null }[]): typeof items {
  const byRef = new Map(items.filter((i) => i.node.ref).map((i) => [i.node.ref as string, i]));
  const done = new Set<string>();
  const result: typeof items = [];
  let guard = 0;
  const remaining = [...items];
  while (remaining.length && guard++ < 10000) {
    const idx = remaining.findIndex((i) => {
      const deps = [...(i.node.dependsOn || []), ...(i.parentRef ? [i.parentRef] : [])];
      return deps.every((d) => !byRef.has(d) || done.has(d));
    });
    const pick = idx >= 0 ? remaining.splice(idx, 1)[0] : remaining.shift()!; // si hay ciclo, forzamos
    if (pick.node.ref) done.add(pick.node.ref);
    result.push(pick);
  }
  return result;
}

export async function POST(req: Request) {
  if (!COMPANY || !TOKEN) {
    return Response.json({ error: "falta AICOS_COMPANY_ID o token de Paperclip en el env del dashboard" }, { status: 500 });
  }
  let spec: AicosSpec;
  try {
    const body = await req.json();
    spec = body.spec || body;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!spec.tasks?.length) {
    return Response.json({ error: "la spec no tiene tasks" }, { status: 400 });
  }

  const warnings: string[] = [];
  const agents = agentIdMap();
  const ceoId = agents["ceo"] || undefined;

  // 1) proyecto
  let projectId: string | undefined = DEFAULT_PROJECT || undefined;
  if (spec.newProject?.name) {
    const { code, data } = await pc("POST", `/api/companies/${COMPANY}/projects`, {
      name: spec.newProject.name,
      description: spec.newProject.description || spec.summary || "",
    });
    if (code === 200 || code === 201) projectId = data?.id;
    else warnings.push(`no pude crear el proyecto (HTTP ${code}: ${JSON.stringify(data).slice(0, 160)}) — sigo sin proyecto`);
  }

  // 2) goal padre (asignado al CEO)
  const parentBody: Record<string, unknown> = {
    title: spec.title || "Goal (Strategy Room)",
    description: spec.summary || "",
    priority: "high",
    status: "backlog",
  };
  if (projectId) parentBody.projectId = projectId;
  if (ceoId) parentBody.assigneeAgentId = ceoId;
  const parentRes = await pc("POST", `/api/companies/${COMPANY}/issues`, parentBody);
  if (parentRes.code !== 200 && parentRes.code !== 201) {
    return Response.json({ error: `no pude crear el goal padre (HTTP ${parentRes.code})`, detail: parentRes.data, warnings }, { status: 502 });
  }
  const parent = { id: parentRes.data.id as string, identifier: parentRes.data.identifier as string };

  // 3) tareas + subtareas (topo-ordenadas), como hijos del padre/su task
  const ordered = topoSort(flatten(spec.tasks));
  const refToId: Record<string, string> = {};
  const created: { ref?: string; identifier: string; id: string; agentId?: string }[] = [];

  for (const { node, parentRef } of ordered) {
    const assignee = node.agentId ? agents[node.agentId] : undefined;
    if (node.agentId && !assignee) warnings.push(`agentId "${node.agentId}" no está en el registry — la tarea "${node.title}" queda sin asignar`);
    const blockedBy = (node.dependsOn || []).map((d) => refToId[d]).filter(Boolean);
    const issueBody: Record<string, unknown> = {
      title: node.title,
      description: node.description || "",
      priority: "medium",
      status: "backlog",
      parentId: parentRef && refToId[parentRef] ? refToId[parentRef] : parent.id,
    };
    if (projectId) issueBody.projectId = projectId;
    if (assignee) issueBody.assigneeAgentId = assignee;
    if (blockedBy.length) issueBody.blockedByIssueIds = blockedBy;

    const { code, data } = await pc("POST", `/api/companies/${COMPANY}/issues`, issueBody);
    if (code === 200 || code === 201) {
      if (node.ref) refToId[node.ref] = data.id;
      created.push({ ref: node.ref, identifier: data.identifier, id: data.id, agentId: node.agentId });
    } else {
      warnings.push(`falló crear "${node.title}" (HTTP ${code}: ${JSON.stringify(data).slice(0, 120)})`);
    }
  }

  return Response.json({ ok: true, projectId, parent, created, warnings });
}
