/**
 * Goal (Strategy Room) — construcción del issue PADRE ("goal") que se crea en
 * Paperclip al aplicar una spec.
 *
 * El padre lo agarra el CEO: tiene que ser auto-explicativo. Antes se creaba con
 * el título placeholder "Goal (Strategy Room)" y `description: spec.summary || ""`
 * (a veces vacío), así que quien lo tomaba arrancaba sin contexto. Acá derivamos:
 *   - un TÍTULO con sentido (cadena de fallback, nunca el placeholder pelado si hay algo mejor), y
 *   - un BRIEF en markdown auto-contenido (objetivo + alcance + plan + roadmap + decisiones)
 * para que el goal que cae en la cola del CEO sea accionable de una.
 *
 * Funciones puras (no tocan red ni disco) → fáciles de testear y reusar.
 */

export interface GoalSpecTask {
  ref?: string;
  title: string;
  description?: string;
  agentId?: string;
  dependsOn?: string[];
  subtasks?: GoalSpecTask[];
}
export interface GoalSpecPhase {
  phase?: string;
  title?: string;
  items?: string[];
}
export interface GoalSpecDecision {
  question?: string;
  choice?: string;
  rationale?: string;
}
export interface GoalSpec {
  title?: string;
  summary?: string;
  newProject?: { name: string; description?: string } | null;
  toolsNeeded?: string[];
  connectionsNeeded?: string[];
  tasks?: GoalSpecTask[];
  roadmap?: GoalSpecPhase[];
  decisions?: GoalSpecDecision[];
}

const PLACEHOLDER = "Goal (Strategy Room)";

/** Cuenta tareas + subtareas (recursivo). */
export function countTasks(tasks: GoalSpecTask[] = []): number {
  return tasks.reduce((n, t) => n + 1 + countTasks(t.subtasks), 0);
}

/**
 * Título del goal. Cadena de fallback para no caer nunca en un placeholder vacío
 * si hay algo más informativo a mano:
 *   spec.title → nombre del proyecto nuevo → primera tarea → placeholder.
 */
export function buildGoalTitle(spec: GoalSpec): string {
  const candidates = [
    spec.title?.trim(),
    spec.newProject?.name ? `${spec.newProject.name.trim()} — objetivo` : "",
    spec.tasks?.[0]?.title?.trim(),
  ];
  for (const c of candidates) if (c) return c.slice(0, 200);
  return PLACEHOLDER;
}

/**
 * Brief del goal en markdown, auto-contenido. Pensado para el cuerpo del issue
 * padre que toma el CEO: objetivo, alcance, plan de alto nivel, roadmap y
 * decision-log, todo inline. Best-effort: cualquier campo ausente se omite.
 */
export function buildGoalBrief(spec: GoalSpec): string {
  const lines: string[] = [];

  lines.push("## 🎯 Objetivo");
  lines.push(spec.summary?.trim() || "_(Sin resumen — ver tareas hijas para el alcance.)_");
  lines.push("");

  if (spec.newProject?.name) {
    lines.push(
      `**Proyecto nuevo:** ${spec.newProject.name}${spec.newProject.description ? ` — ${spec.newProject.description}` : ""}`,
      "",
    );
  }

  if (spec.toolsNeeded?.length) lines.push(`**Tools necesarias:** ${spec.toolsNeeded.join(", ")}`, "");
  if (spec.connectionsNeeded?.length) lines.push(`**Conexiones necesarias:** ${spec.connectionsNeeded.join(", ")}`, "");

  const total = countTasks(spec.tasks);
  if (total) {
    lines.push(`## 🧩 Plan (${total} tarea${total === 1 ? "" : "s"})`);
    for (const t of spec.tasks || []) {
      lines.push(`- **${t.title}**${t.agentId ? ` _(${t.agentId})_` : ""}`);
      for (const st of t.subtasks || []) lines.push(`  - ${st.title}${st.agentId ? ` _(${st.agentId})_` : ""}`);
    }
    lines.push("");
  }

  if (spec.roadmap?.length) {
    lines.push("## 🛣 Roadmap post-MVP");
    for (const ph of spec.roadmap) {
      const head = [ph.phase, ph.title].filter(Boolean).join(" — ") || "Fase";
      lines.push(`- **${head}**${ph.items?.length ? `: ${ph.items.join(", ")}` : ""}`);
    }
    lines.push("");
  }

  if (spec.decisions?.length) {
    lines.push("## ✅ Decisiones");
    for (const d of spec.decisions) {
      lines.push(`- **${d.question || "Decisión"}** → ${d.choice || "—"}${d.rationale ? ` _(${d.rationale})_` : ""}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("_Goal generado por la Strategy Room (AICOS). Como CEO: descomponé, priorizá y coordiná la ejecución de las tareas hijas._");

  return lines.join("\n").trim() + "\n";
}
