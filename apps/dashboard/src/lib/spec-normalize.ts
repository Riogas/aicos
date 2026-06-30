/**
 * Normalizador de specs de la Strategy Room.
 *
 * El CEO/Hermes (Opus) a veces se desvía del schema canónico del `aicos-spec`
 * (definido en studio-prompt.ts) e inventa nombres de campo "más pro":
 *   project → newProject, owner → agentId, id → ref,
 *   deliverables/acceptance/support → (texto suelto), frozenDecisions → decisions.
 *
 * Sin normalizar, el apply no encuentra `newProject` (no crea proyecto) ni
 * `agentId` (deja las tareas sin asignar → nadie las despacha). Esta función
 * toma una spec "suelta" y devuelve la forma canónica que el apply y el panel
 * entienden. Es defensiva: campos ausentes se omiten, nunca tira.
 */

export interface NSpecTask {
  ref?: string;
  title: string;
  description?: string;
  agentId?: string;
  dependsOn?: string[];
  subtasks?: NSpecTask[];
}
export interface NSpecPhase {
  phase?: string;
  title?: string;
  items?: string[];
}
export interface NSpecDecision {
  question?: string;
  choice?: string;
  rationale?: string;
}
export interface NSpec {
  title?: string;
  summary?: string;
  newProject?: { name: string; description?: string } | null;
  toolsNeeded?: string[];
  connectionsNeeded?: string[];
  tasks?: NSpecTask[];
  roadmap?: NSpecPhase[];
  decisions?: NSpecDecision[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function str(v: any): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  return undefined;
}
function arrStr(v: any): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === "string" ? x : typeof x?.title === "string" ? x.title : String(x))).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

/** Junta description + deliverables + acceptance + support en un solo texto markdown. */
function mergeDesc(t: any): string | undefined {
  const parts: string[] = [];
  const d = str(t.description) || str(t.detail) || str(t.detalle);
  if (d) parts.push(d);
  const deliver = arrStr(t.deliverables) || arrStr(t.entregables);
  if (deliver) parts.push("**Entregables:**\n" + deliver.map((x) => `- ${x}`).join("\n"));
  const accept = arrStr(t.acceptance) || arrStr(t.acceptanceCriteria) || arrStr(t.criterios);
  if (accept) parts.push("**Criterios de aceptación:**\n" + accept.map((x) => `- ${x}`).join("\n"));
  const support = arrStr(t.support) || arrStr(t.apoyo);
  if (support) parts.push(`**Apoyo:** ${support.join(", ")}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

function normalizeTask(t: any): NSpecTask | null {
  if (!t || typeof t !== "object") return null;
  const title = str(t.title) || str(t.name) || str(t.titulo);
  if (!title) return null;
  const subs = Array.isArray(t.subtasks || t.subTasks || t.children)
    ? (t.subtasks || t.subTasks || t.children).map(normalizeTask).filter(Boolean)
    : undefined;
  const dependsOn = arrStr(t.dependsOn) || arrStr(t.depends_on) || arrStr(t.deps);
  return {
    ref: str(t.ref) || str(t.id) || str(t.key),
    title,
    description: mergeDesc(t),
    agentId: str(t.agentId) || str(t.owner) || str(t.assignee) || str(t.responsable),
    dependsOn: dependsOn || [],
    subtasks: subs && subs.length ? (subs as NSpecTask[]) : undefined,
  };
}

function normalizeDecisions(raw: any): NSpecDecision[] | undefined {
  const src = raw.decisions || raw.frozenDecisions || raw.decisionLog;
  if (!Array.isArray(src)) return undefined;
  const out = src
    .map((d: any) => {
      if (!d || typeof d !== "object") return null;
      return {
        question: str(d.question) || str(d.decision) || str(d.id),
        choice: str(d.choice) || str(d.decision) || str(d.elegido),
        rationale: str(d.rationale) || str(d.implies) || str(d.why) || str(d.porque),
      };
    })
    .filter(Boolean) as NSpecDecision[];
  return out.length ? out : undefined;
}

function normalizeRoadmap(raw: any): NSpecPhase[] | undefined {
  const src = raw.roadmap || raw.phases || raw.fases;
  if (!Array.isArray(src)) return undefined;
  const out = src
    .map((p: any) => {
      if (!p || typeof p !== "object") return null;
      return { phase: str(p.phase) || str(p.fase), title: str(p.title) || str(p.titulo), items: arrStr(p.items) || arrStr(p.items) };
    })
    .filter(Boolean) as NSpecPhase[];
  return out.length ? out : undefined;
}

/** project (suelto) o newProject (canónico) → newProject canónico. */
function normalizeProject(raw: any): { name: string; description?: string } | null | undefined {
  // newProject explícito gana (incluido null deliberado = "va en proyecto existente")
  if (raw.newProject === null) return null;
  if (raw.newProject && typeof raw.newProject === "object") {
    const name = str(raw.newProject.name) || str(raw.newProject.slug);
    if (name) return { name, description: str(raw.newProject.description) };
  }
  const p = raw.project || raw.proyecto;
  if (p && typeof p === "object") {
    const name = str(p.name) || str(p.nombre) || str(p.slug);
    if (name) return { name, description: str(p.description) || str(p.rationale) || str(p.descripcion) };
  }
  return undefined;
}

export function normalizeSpec(raw: any): NSpec {
  if (!raw || typeof raw !== "object") return raw as NSpec;
  const proj = normalizeProject(raw);
  const tasks = Array.isArray(raw.tasks || raw.tareas)
    ? (raw.tasks || raw.tareas).map(normalizeTask).filter(Boolean)
    : [];
  return {
    title: str(raw.title) || str(raw.titulo) || (proj ? proj.name : undefined) || str(raw.name),
    summary: str(raw.summary) || str(raw.resumen) || str(raw.objetivo) || (raw.project ? str(raw.project.rationale) : undefined),
    newProject: proj,
    toolsNeeded: arrStr(raw.toolsNeeded) || arrStr(raw.tools),
    connectionsNeeded: arrStr(raw.connectionsNeeded) || arrStr(raw.connections),
    tasks: tasks as NSpecTask[],
    roadmap: normalizeRoadmap(raw),
    decisions: normalizeDecisions(raw),
  };
}
