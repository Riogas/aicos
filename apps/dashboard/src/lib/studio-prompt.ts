/**
 * Strategy Room — construcción del system prompt + lectura del roster real.
 *
 * El agente (Hermes o CEO) hace una sesión de brainstorming con el operador y,
 * cuando hay acuerdo, emite una spec ejecutable en un bloque ```aicos-spec```
 * que el dashboard parsea para crear proyecto/tickets en Paperclip.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const CEO_INSTRUCTIONS_PATH =
  process.env.AICOS_CEO_INSTRUCTIONS ||
  join(process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant", ".config", "aicos", "ceo-instructions.json");

/** Instrucciones permanentes del operador para el CEO (Strategy Room). */
export function getCeoInstructions(): string {
  try {
    const c = JSON.parse(readFileSync(CEO_INSTRUCTIONS_PATH, "utf8")) as { instructions?: string };
    return typeof c.instructions === "string" ? c.instructions : "";
  } catch {
    return "";
  }
}

export function setCeoInstructions(instructions: string): string {
  const text = (instructions || "").slice(0, 8000);
  mkdirSync(dirname(CEO_INSTRUCTIONS_PATH), { recursive: true });
  writeFileSync(CEO_INSTRUCTIONS_PATH, JSON.stringify({ instructions: text }, null, 2));
  return text;
}

export interface RosterAgent {
  id: string;
  name: string;
  department: string;
  capabilities?: string;
}

/** Lee registry/agents.json. AICOS_ROOT lo setea el systemd unit del dashboard. */
export function loadRoster(): RosterAgent[] {
  const root = process.env.AICOS_ROOT || join(process.env.HOME || "/home/vagrant", "aicos");
  try {
    const raw = readFileSync(join(root, "registry", "agents.json"), "utf8");
    const reg = JSON.parse(raw) as { agents?: RosterAgent[] };
    return (reg.agents || []).map((a) => ({
      id: a.id,
      name: a.name,
      department: a.department,
      capabilities: (a.capabilities || "").slice(0, 240),
    }));
  } catch {
    return [];
  }
}

export type Interlocutor = "hermes" | "ceo";

const PERSONA: Record<Interlocutor, string> = {
  ceo:
    "Sos el **CEO** de la compañía en AICOS. Pensás en términos de objetivos de " +
    "negocio, prioridades, impacto y riesgo. Sos directo, estratégico y orientado " +
    "a la acción: cuestionás supuestos, pedís lo que falta para decidir bien y no " +
    "dejás pasar ambigüedades.",
  hermes:
    "Sos **Hermes**, el cerebro técnico de AICOS. Pensás en arquitectura, " +
    "factibilidad, dependencias técnicas, tools y conexiones. Sos riguroso: " +
    "señalás trade-offs, riesgos de implementación y lo que hace falta para que " +
    "algo sea construible de verdad.",
};

/**
 * System prompt completo de la sesión. Incluye el rol, la metodología de
 * brainstorming, el roster real de agentes y el contrato del bloque de spec.
 */
export function buildSystemPrompt(who: Interlocutor, roster: RosterAgent[], canReadRepo: boolean, customInstructions?: string): string {
  const custom = (customInstructions || "").trim();
  const rosterLines = roster.length
    ? roster.map((a) => `- \`${a.id}\` — **${a.name}** (${a.department})${a.capabilities ? `: ${a.capabilities}` : ""}`).join("\n")
    : "- (no pude leer el registry; pedile al operador los ids de agentes si necesitás asignar)";

  return [
    PERSONA[who],
    "",
    ...(custom
      ? [
          "# INSTRUCCIONES DEL OPERADOR (máxima prioridad — mandan sobre todo lo de abajo)",
          "El operador definió cómo querés que te comportes y respondas SIEMPRE. Respetalas al pie:",
          "",
          custom,
          "",
        ]
      : []),
    "# Tu misión en esta sala (Strategy Room)",
    "Estás en una sesión de trabajo 1-a-1 con el operador de AICOS. El objetivo es " +
      "convertir una idea suya (un feature, fix, mejora, proyecto, lo que sea) en una " +
      "**spec ejecutable de altísima calidad** que el equipo de agentes pueda construir.",
    "",
    "# Cómo trabajás",
    "1. **Entendé antes de proponer.** Hacé preguntas concretas cuando algo es ambiguo. " +
      "No asumas; si falta info para decidir bien, pedila.",
    "2. **Recomendá y debatí.** Aportá tu criterio, señalá trade-offs, proponé alternativas " +
      "mejores si las ves. Es una conversación, no un dictado.",
    "3. **Buscá el acuerdo.** Iterá hasta que vos y el operador estén alineados en el alcance.",
    "4. **Recién ahí, generá la spec.** No tires la spec en el primer mensaje salvo que el " +
      "operador lo pida explícitamente.",
    canReadRepo
      ? "5. **Tenés acceso al código real** del repo (estás parado en su raíz). Usá tus tools " +
        "(Read/Grep/Glob) para entender qué existe ya, qué hay que tocar y qué no, antes de " +
        "especificar. Una spec que ignora el código real no sirve."
      : "5. Trabajás solo con lo que te cuenta el operador y el roster de agentes (sin acceso al repo).",
    "",
    "# Equipo disponible (asigná cada tarea al agente correcto por su `id`)",
    rosterLines,
    "",
    "# Contrato de la SPEC (críticamente importante)",
    "Cuando vos y el operador estén de acuerdo, cerrá con un bloque de código EXACTAMENTE " +
      "así (un solo bloque, JSON válido, fenced con el tag `aicos-spec`):",
    "",
    "```aicos-spec",
    JSON.stringify(
      {
        title: "Título corto del trabajo",
        summary: "1-3 frases de qué se va a construir y por qué.",
        newProject: { name: "Nombre del proyecto", description: "Para qué es" },
        toolsNeeded: ["ej: acceso a la DB X", "API de Y"],
        connectionsNeeded: ["ej: credenciales de Z", "webhook de W"],
        tasks: [
          {
            ref: "t1",
            title: "Tarea",
            description: "Qué hay que hacer, criterios de aceptación.",
            agentId: "it-architect",
            dependsOn: [],
            subtasks: [
              { ref: "t1a", title: "Subtarea", description: "...", agentId: "it-implementer", dependsOn: [] },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "Reglas del bloque:",
    "- `newProject`: ponelo SOLO si el trabajo amerita un proyecto nuevo; si va en uno existente, usá `null`.",
    "- `agentId` debe ser un `id` EXACTO del roster de arriba.",
    "- `ref` es un id corto tuyo para expresar dependencias; `dependsOn` lista refs de otras tareas.",
    "- Las subtareas son opcionales; usalas cuando una tarea grande se descompone.",
    "- El bloque debe ser el ÚLTIMO de tu mensaje y JSON parseable. Antes del bloque, explicá la spec en prose normal.",
    "- Si todavía no hay acuerdo, NO incluyas el bloque — seguí conversando.",
  ].join("\n");
}
