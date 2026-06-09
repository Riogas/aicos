import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelPref {
  cli: string;
  model: string;
}

export interface RegistryAgent {
  id: string;
  department: string;
  name: string;
  capabilities?: string;
  systemPrompt?: string;
  preferredModel?: ModelPref;
  fallbackChain?: ModelPref[];
  constraints?: string[];
  tools?: string[];
  paperclipAgentId?: string;
}

export interface RegistryFile {
  departments: { id: string; name: string; color?: string }[];
  agents: RegistryAgent[];
}

export interface AgentKeyEntry {
  agentName: string;
  paperclipAgentId: string;
  keyId: string;
  token: string;
}

export interface PersonaResolution {
  registryId: string;
  agentName: string;
  department: string;
  systemPrompt: string;
  preferredModel?: ModelPref;
  fallbackChain: ModelPref[];
  apiKey: string;
}

const ROOT = process.env.AICOS_ROOT ?? join(homedir(), "aicos");
const REGISTRY_PATH = join(ROOT, "registry", "agents.json");
const KEYS_PATH = join(ROOT, ".secrets", "agent-keys.json");
const WORKSPACES_PATH = join(ROOT, "registry", "project-workspaces.json");

export interface ProjectWorkspace {
  projectName: string;
  cwd: string;
  gitRemote: string | null;
  defaultBranch: string;
}

export interface ProjectWorkspacesFile {
  workspaces: Record<string, ProjectWorkspace>;
}

let cachedRegistry: RegistryFile | null = null;
let cachedKeys: Record<string, AgentKeyEntry> | null = null;
let cachedWorkspaces: Record<string, ProjectWorkspace> | null = null;
let cachedByPaperclipId: Map<string, PersonaResolution> | null = null;
let cachedByRegistryId: Map<string, PersonaResolution> | null = null;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function buildIndex(): {
  byPid: Map<string, PersonaResolution>;
  byRid: Map<string, PersonaResolution>;
} {
  const reg = cachedRegistry;
  const keys = cachedKeys;
  const byPid = new Map<string, PersonaResolution>();
  const byRid = new Map<string, PersonaResolution>();
  if (!reg || !keys) return { byPid, byRid };

  for (const a of reg.agents) {
    if (!a.paperclipAgentId) continue;
    const k = keys[a.id];
    if (!k?.token) continue;
    const resolution: PersonaResolution = {
      registryId: a.id,
      agentName: a.name,
      department: a.department,
      systemPrompt: a.systemPrompt ?? "",
      preferredModel: a.preferredModel,
      fallbackChain: a.fallbackChain ?? [],
      apiKey: k.token,
    };
    byPid.set(a.paperclipAgentId, resolution);
    byRid.set(a.id, resolution);
  }
  return { byPid, byRid };
}

export interface RegistryStats {
  totalAgents: number;
  agentsWithPaperclipId: number;
  agentsWithKey: number;
  resolvable: number;
  projectWorkspaces: number;
  registryPath: string;
  keysPath: string;
  workspacesPath: string;
  registryLoaded: boolean;
  keysLoaded: boolean;
  workspacesLoaded: boolean;
}

export function loadRegistry(): RegistryStats {
  cachedRegistry = readJson<RegistryFile>(REGISTRY_PATH);
  cachedKeys = readJson<Record<string, AgentKeyEntry>>(KEYS_PATH);
  const wsFile = readJson<ProjectWorkspacesFile>(WORKSPACES_PATH);
  cachedWorkspaces = wsFile?.workspaces ?? null;
  const idx = buildIndex();
  cachedByPaperclipId = idx.byPid;
  cachedByRegistryId = idx.byRid;

  return {
    totalAgents: cachedRegistry?.agents.length ?? 0,
    agentsWithPaperclipId:
      cachedRegistry?.agents.filter((a) => a.paperclipAgentId).length ?? 0,
    agentsWithKey: cachedKeys ? Object.keys(cachedKeys).length : 0,
    resolvable: idx.byPid.size,
    projectWorkspaces: cachedWorkspaces ? Object.keys(cachedWorkspaces).length : 0,
    registryPath: REGISTRY_PATH,
    keysPath: KEYS_PATH,
    workspacesPath: WORKSPACES_PATH,
    registryLoaded: Boolean(cachedRegistry),
    keysLoaded: Boolean(cachedKeys),
    workspacesLoaded: Boolean(cachedWorkspaces),
  };
}

export function resolveWorkspaceByProjectId(
  projectId: string,
): ProjectWorkspace | null {
  return cachedWorkspaces?.[projectId] ?? null;
}

export function resolvePersonaByPaperclipId(
  paperclipAgentId: string,
): PersonaResolution | null {
  return cachedByPaperclipId?.get(paperclipAgentId) ?? null;
}

export function resolvePersonaByRegistryId(
  registryId: string,
): PersonaResolution | null {
  return cachedByRegistryId?.get(registryId) ?? null;
}

export function formatModelPref(m: ModelPref | undefined): string {
  if (!m) return "(sin preferencia)";
  return `${m.cli}/${m.model}`;
}

/**
 * Genera el bloque de "persona prompt" que se prepende al task markdown.
 * Output esta pensado para ser util a Hermes-Nous en -z mode.
 */
export function buildPersonaPrompt(
  persona: PersonaResolution,
  task: string,
  workspace?: ProjectWorkspace | null,
): string {
  const sp = persona.systemPrompt?.trim() || "(sin system prompt)";
  const pref = formatModelPref(persona.preferredModel);
  const fallback =
    persona.fallbackChain.length === 0
      ? "(sin fallback chain)"
      : persona.fallbackChain
          .map((m, i) => `  ${i + 1}. ${formatModelPref(m)}`)
          .join("\n");

  const cliCmd = persona.preferredModel?.cli ?? "claude";
  const cliModel = persona.preferredModel?.model;
  const cwdLine = workspace ? workspace.cwd : ".";
  const runCmd = (() => {
    const promptArg = "<<<TASK>>>"; // marker for clarity
    if (cliCmd === "claude") return `claude -p ${promptArg}`;
    if (cliCmd === "codex")
      return `codex exec --skip-git-repo-check --cd ${cwdLine} ${promptArg}`;
    if (cliCmd === "agy") return `agy -p ${promptArg}`;
    if (cliCmd === "opencode")
      return `opencode run -m ${cliModel ?? "moonshotai/kimi-k2-instruct"} ${promptArg}`;
    return `claude -p ${promptArg}`;
  })();

  return [
    `# EXECUTION CONTRACT — read carefully, follow strictly`,
    ``,
    `Sos **${persona.agentName}** (${persona.registryId}, dept=${persona.department}).`,
    `Tu rol: ${sp}`,
    ``,
    `**REGLA CRITICA**: NO escribas una respuesta conversacional describiendo lo que se deberia hacer.`,
    `DEBES usar tu terminal/Bash tool para ejecutar comandos shell que produzcan el resultado real.`,
    `Si solo describis el plan en texto, este ticket falla. El humano necesita ARCHIVOS, no descripciones.`,
    ``,
    `# 1. WORKSPACE`,
    workspace
      ? `Tu working directory para esta tarea es \`${workspace.cwd}\` (proyecto "${workspace.projectName}", branch \`${workspace.defaultBranch}\`).`
      : `No tenes workspace dedicado — trabaja en el cwd actual.`,
    `**Antes de cualquier comando, haces \`cd ${cwdLine}\`.** Todos los archivos se crean ahi.`,
    ``,
    `# 2. EJECUCION`,
    `Tu CLI preferida es \`${cliCmd}\`${cliModel ? ` (modelo ${cliModel})` : ""}.`,
    `Para ejecutar la tarea, usa tu terminal tool para correr este comando (reemplaza <<<TASK>>> por el contenido literal de la seccion "TAREA" mas abajo, escapado para shell):`,
    ``,
    "```bash",
    `cd ${cwdLine}`,
    runCmd,
    "```",
    ``,
    `Esperas a que termine. Si el primer CLI falla por rate-limit / auth / timeout, intenta tu fallback chain en orden:`,
    fallback,
    ``,
    `# 3. VERIFICACION`,
    `Despues de ejecutar la CLI, corre estos comandos en tu terminal para confirmar:`,
    "```bash",
    `cd ${cwdLine}`,
    `git status --short`,
    `git diff --stat | tail -20`,
    "```",
    ``,
    `Si \`git status\` devuelve vacio, la CLI no escribio nada — intenta de nuevo con instrucciones mas explicitas o reportalo como bloqueado.`,
    ``,
    `# 4. OUTPUT FINAL`,
    `Cuando termina todo, tu respuesta de texto debe ser un resumen compacto (5-10 lineas):`,
    `- Que archivos creaste/modificaste`,
    `- Si commiteaste algo (no pushees sin pedirlo el usuario)`,
    `- Si hubo errores, cuales`,
    `- Sugerencia de proximos pasos (si aplica)`,
    ``,
    `# TAREA`,
    task.trim(),
    ``,
    `---`,
    `Recordatorio final: tu trabajo es EJECUTAR, no PLANIFICAR. Si la tarea esta ambigua, eligi una interpretacion razonable y ejecutala. No pidas mas detalles — el humano confia en tu juicio.`,
  ].join("\n");
}
