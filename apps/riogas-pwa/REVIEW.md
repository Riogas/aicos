# IT Code Review — README riogas-pwa (post RIO-38)

**Reviewer:** it-code-reviewer (IT) · **Fecha:** 2026-06-10
**Archivo revisado:** `apps/riogas-pwa/README.md`

## Veredicto: CHANGES_REQUESTED

El README cubre descripción, stack e instrucciones, y las instrucciones de ejecución
son reproducibles (verificado: `node validate.js` → `ALL_SCREENS_RENDER_OK`, 17 pantallas;
ruta de `python3 -m http.server` correcta). Pero el mapa de archivos referencia un
entregable inexistente y omite archivos que el propio README manda a usar.

## Findings

1. **[BLOQUEANTE] Referencia rota.** El árbol "Qué hay acá" (línea 25) lista
   `docs/ux/05-qa-validation-checklist.md` como parte del paquete, pero el archivo
   **no existe** (`docs/ux/` solo tiene `00`–`04`). El README apunta a un entregable
   que no está. → Crear el archivo, o quitar la línea del árbol.

2. **[MENOR] Árbol inconsistente con `wireframes/`.** El árbol (líneas 16–18) lista solo
   `index.html`, `styles.css`, `app.js`, pero:
   - Omite `validate.js`, que el propio README manda ejecutar en "Validación headless"
     (línea 53). Un archivo que se usa debe figurar en el mapa.
   - Omite el directorio `assets/` (existe en `wireframes/`).
   → Agregar ambos al árbol.

## OK (sin cambios)

- Descripción del proyecto y alcance del entregable: claros.
- Stack objetivo declarado (Next.js 14 App Router · React 18 · TS · Tailwind 3).
- Instrucciones de visualización y validación: reproducibles y verificadas.

## Nota fuera de alcance (no bloquea este README)

La implementación Next.js vive en `apps/paperclip-bridge/riogas-pwa/` y **no tiene
README propio** (cómo correr `npm i && npm run dev -p 3010`). Si el alcance incluye
documentar la app implementada, falta ese README. Este review se limita al README
de `apps/riogas-pwa/` según RIO-38.
