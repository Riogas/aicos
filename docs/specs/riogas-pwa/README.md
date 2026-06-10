# riogas-pwa — paquete de arquitectura

Entregables del IT Architect para el MVP de `riogas-pwa` (PWA de promociones de supergás).

| Archivo | Contenido |
| --- | --- |
| [`../2026-06-10-riogas-pwa-architecture.md`](../2026-06-10-riogas-pwa-architecture.md) | Documento principal: stack, diagrama lógico, modelo de datos (entidades), tradeoffs, riesgos, layout de scaffold. |
| [`openapi.yaml`](./openapi.yaml) | Contratos API mock (OpenAPI 3.1): consulta de promociones, reserva, estado, historial, canje, admin y **API externa** a implementar. |
| `mocks/*.json` | Respuestas de ejemplo referenciadas desde el OpenAPI. |

## Cómo usar

- **Front/back dev:** programar contra `openapi.yaml`. Levantar mock server con
  `npx @stoplight/prism-cli mock docs/specs/riogas-pwa/openapi.yaml` para servir los ejemplos.
- **Integración externa:** la sección `external` define el contrato que el proveedor de
  promociones debe implementar; mientras no exista, se usa `PROMOS_PROVIDER=mock`.

## Decisión clave

Identidad (login Google/email + teléfono obligatorio) está **desacoplada** de la
elegibilidad (código libre resuelto por API externa). Ver §0 del documento principal
para la reconciliación con las specs originales del analyst (CI+OTP/padrón).
