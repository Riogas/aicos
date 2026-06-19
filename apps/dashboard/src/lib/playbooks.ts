/**
 * Playbooks = plantillas de spec reutilizables para arrancar trabajo común con
 * un click desde el Strategy Room. Cada playbook inyecta un mensaje plantilla en
 * el chat (con [placeholders] que el operador completa); el CEO/Hermes lo
 * expande a una spec ejecutable con el flujo de siempre.
 *
 * Built-ins en código + custom persistidos en ~/.config/aicos/playbooks.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const STORE_PATH = process.env.AICOS_PLAYBOOKS_STORE || join(HOME, ".config", "aicos", "playbooks.json");

export type Interlocutor = "ceo" | "hermes";
export interface Playbook {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  category?: string;
  interlocutor?: Interlocutor;
  model?: "opus" | "sonnet";
  template: string;       // mensaje a inyectar en el chat; usa [placeholders]
  builtin?: boolean;
}

/** Catálogo de fábrica — cubre el trabajo más común. */
export const BUILTIN_PLAYBOOKS: Playbook[] = [
  {
    id: "nuevo-microservicio",
    name: "Nuevo microservicio",
    description: "Especificar y desglosar un servicio nuevo de punta a punta.",
    emoji: "🧱",
    category: "Build",
    interlocutor: "ceo",
    model: "opus",
    template:
      "Quiero un microservicio nuevo: [nombre y qué resuelve].\n\n" +
      "Definamos juntos: stack/lenguaje, endpoints principales, modelo de datos, " +
      "dependencias/integraciones, estrategia de tests y cómo se despliega. " +
      "Preguntame lo que falte y cuando estemos de acuerdo generá la spec con el " +
      "desglose de tareas y responsables.",
  },
  {
    id: "nueva-feature",
    name: "Nueva feature",
    description: "Feature de producto: diseño → implementación → validación.",
    emoji: "✨",
    category: "Build",
    interlocutor: "ceo",
    model: "opus",
    template:
      "Feature nueva para [producto/repo]: [qué tiene que hacer y para quién].\n\n" +
      "Quiero contemplar UX, criterios de aceptación, edge cases y tests. " +
      "Si toca un repo existente, revisá el código real antes de especificar. " +
      "Armá la spec con tareas y quién hace cada una.",
  },
  {
    id: "bugfix-con-tests",
    name: "Bugfix con tests",
    description: "Reproducir, arreglar y blindar con un test de regresión.",
    emoji: "🐛",
    category: "Mantenimiento",
    interlocutor: "ceo",
    model: "sonnet",
    template:
      "Bug en [repo/módulo]: [síntoma]. Pasos para reproducir: [pasos]. " +
      "Esperado: [comportamiento esperado].\n\n" +
      "Quiero: reproducir el bug, encontrar la causa raíz, arreglarlo y dejar un " +
      "test de regresión que lo cubra. Generá la spec.",
  },
  {
    id: "auditoria-seguridad",
    name: "Auditoría de seguridad",
    description: "Revisión OWASP de un repo + plan de remediación.",
    emoji: "🛡️",
    category: "Calidad",
    interlocutor: "ceo",
    model: "opus",
    template:
      "Auditoría de seguridad de [repo]. Revisá OWASP Top 10: inyección, authn/authz, " +
      "secrets expuestos, deserialización, deps vulnerables, configs inseguras, etc.\n\n" +
      "Quiero un informe de hallazgos priorizado por severidad y una spec con las " +
      "tareas de remediación.",
  },
  {
    id: "refactor",
    name: "Refactor / deuda técnica",
    description: "Identificar deuda, plan de refactor seguro con tests.",
    emoji: "♻️",
    category: "Mantenimiento",
    interlocutor: "ceo",
    model: "opus",
    template:
      "Refactor de [repo/módulo]. Objetivo: [qué mejorar — legibilidad, performance, " +
      "acoplamiento, etc.].\n\n" +
      "Revisá el código real, identificá la deuda, proponé un plan de refactor que no " +
      "rompa comportamiento (con tests que lo respalden) y armá la spec por pasos.",
  },
  {
    id: "integracion-api",
    name: "Integración / conector",
    description: "Conectar con una API o servicio externo.",
    emoji: "🔌",
    category: "Build",
    interlocutor: "ceo",
    model: "opus",
    template:
      "Integrar [repo] con [servicio/API externa]. Caso de uso: [qué necesitamos hacer].\n\n" +
      "Definamos auth, endpoints a usar, manejo de errores/reintentos, rate limits y " +
      "tests. Armá la spec con el desglose.",
  },
  {
    id: "investigacion",
    name: "Investigación / spike",
    description: "Explorar opciones y recomendar un camino, sin comprometer código.",
    emoji: "🔎",
    category: "Discovery",
    interlocutor: "hermes",
    model: "opus",
    template:
      "Necesito investigar: [pregunta o decisión técnica]. Contexto: [contexto].\n\n" +
      "Compará las opciones con tradeoffs (costo, esfuerzo, riesgo, mantenibilidad) y " +
      "recomendá un camino. Si amerita, dejá una spec de la prueba de concepto.",
  },
];

interface Store { custom: Playbook[] }

function readStore(): Store {
  try {
    const d = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (Array.isArray(d)) return { custom: d };
    return { custom: Array.isArray(d.custom) ? d.custom : [] };
  } catch {
    return { custom: [] };
  }
}

function writeStore(s: Store): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
}

/** Built-ins (no borrables) + custom. Un custom con id de built-in lo pisa. */
export function listPlaybooks(): Playbook[] {
  const { custom } = readStore();
  const customIds = new Set(custom.map((c) => c.id));
  const builtins = BUILTIN_PLAYBOOKS.filter((b) => !customIds.has(b.id)).map((b) => ({ ...b, builtin: true }));
  return [...builtins, ...custom.map((c) => ({ ...c, builtin: false }))];
}

export function upsertPlaybook(input: Partial<Playbook>): Playbook {
  const { custom } = readStore();
  const id =
    (input.id || input.name || "playbook").toString().toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "playbook";
  const pb: Playbook = {
    id,
    name: input.name || id,
    description: input.description || "",
    emoji: input.emoji || "📋",
    category: input.category || "Custom",
    interlocutor: input.interlocutor === "hermes" ? "hermes" : "ceo",
    model: input.model === "sonnet" ? "sonnet" : "opus",
    template: input.template || "",
  };
  const next = custom.some((c) => c.id === id)
    ? custom.map((c) => (c.id === id ? pb : c))
    : [...custom, pb];
  writeStore({ custom: next });
  return pb;
}

/** Borra un custom. Si es un built-in, guarda un override "oculto" no soportado:
 *  simplemente no permitimos borrar built-ins (devuelve false). */
export function deletePlaybook(id: string): boolean {
  const { custom } = readStore();
  if (!custom.some((c) => c.id === id)) return false;
  writeStore({ custom: custom.filter((c) => c.id !== id) });
  return true;
}
