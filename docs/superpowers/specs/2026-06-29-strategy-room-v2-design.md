# Strategy Room v2 — decisiones seleccionables, spec viva, read-only blindado, rastro en el proyecto

Fecha: 2026-06-29. Origen: feedback del operador tras un loop de agentes (el CEO read-only
intentó escribir un archivo y encadenó subagentes infinitos).

## Problema
1. El CEO pedía decisiones enterradas en prosa; el operador no podía "decidir" cómodo.
2. La spec no evolucionaba con pedidos antes de crear.
3. El CEO creía que los proyectos viven en `apps/` del monorepo (mal): viven en `/home/riogas/Projects`.
4. Siendo read-only, intentó escribir y entró en loop spawneando agentes (hueco: Task/Monitor no bloqueados).

## Diseño (6 piezas)
1. **Bloque `aicos-decision`**: el CEO emite `{question, options:[{label,description,recommended}], multi}`.
   El cliente lo renderiza como botones clickeables (DecisionBlock). Clic = manda la elección y sigue.
2. **Gate de decisiones**: no arma/modifica la spec hasta tener TODAS las decisiones resueltas; nunca asume defaults.
3. **Spec viva**: re-emite el `aicos-spec` completo ante cambios; el panel ya muestra el último (client.tsx). Nada se crea hasta "Crear en Paperclip".
4. **Read-only blindado**: `--disallowedTools Write,Edit,NotebookEdit,Bash,Task,Agent,Monitor,KillShell,BashOutput` + regla dura: nunca escribir/spawnear; si piden guardar → tarea en la spec o lo persiste apply.
5. **Rastro en el proyecto**: el schema suma `roadmap` y `decisions`; al aplicar, `apply/route.ts` escribe `docs/SPEC.md|ROADMAP.md|DECISIONS.md` en `<projectsRoot>/<slug>` y commitea (slug igual al del bridge).
6. **`/repos` = `/home/riogas/Projects`** (repos.json root).

## Archivos
- lib/studio-prompt.ts, app/api/studio/chat/route.ts, app/api/studio/apply/route.ts,
  app/studio/client.tsx, app/studio/studio.css; config ~/.config/aicos/repos.json.

## Verificación (2026-06-29)
- Build EXIT=0. Probe loop: CEO rechaza, 0 tools, no crea archivo, no spawnea. Probe decisión: 4 bloques `aicos-decision`, sin spec previa. Apply: docs escritos + commit `951a8a2`.
