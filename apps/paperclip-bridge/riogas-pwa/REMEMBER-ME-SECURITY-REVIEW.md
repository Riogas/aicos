# Revisión de seguridad — feature "Recordarme" (riogas-pwa login)

**Veredicto: `CHANGES_REQUESTED` (`SEC_ISSUES` leve)**
**Rol:** IT Security Reviewer (it-security-reviewer, dept it)
**Fecha:** 2026-06-10
**Alcance:** solo el diff que agrega el checkbox "Recordarme en este dispositivo" al login del flujo de beneficiario y la persistencia de sesión asociada.
**Marco:** OWASP Top 10 (2021) + Ley 18.331 (datos personales, Uruguay).

**Archivos revisados:**
- `src/lib/auth.ts` — `REMEMBERED_AUTH_SESSION_KEY`, `persistRememberedSession`, `loadRememberedSession`, `clearRememberedSession`, `parseStoredSession`.
- `src/components/beneficiary-flow.tsx` — estado `rememberMe`, restauración en `useEffect`, `handleLogin`, `handleLogout`, checkbox.
- `test/auth.test.ts` — contrato "persists only the mock session fields needed for remember me".

> Nota de contexto: durante la revisión el workspace estaba siendo reescrito en paralelo por el agente scaffolder de RIO-15 (Next.js/NextAuth). En un instante intermedio `src/lib/auth.ts` quedó solo con `authOptions` y el resto del código no compilaba (imports rotos a `createMockSession`, etc.). El estado final reconcilió ambos. Ver §4-I: validar que el merge final conserve los exports y que `npm test`/`tsc` pasen una vez asentado el scaffold (no se pudieron ejecutar aquí porque `node_modules` se estaba instalando).

---

## 0. Resumen ejecutivo

El diseño base del "Recordarme" es **sólido y seguro en lo esencial**: no persiste credenciales, el estado no-marcado no persiste, el logout limpia todo y el parseo del storage está endurecido. Los hallazgos restantes son de **privacidad/PII y de defensa en profundidad**, no de exposición de credenciales. Se solicita corregir 1 medio (PII sin expiración) y 2 bajos antes de mergear; con eso queda apto.

| Severidad | Cantidad |
|-----------|----------|
| 🔴 Crítica | 0 |
| 🟠 Alta | 0 |
| 🟡 Media | 1 |
| 🔵 Baja | 2 |

---

## 1. Lo que está bien (verificado) ✅

Verificado estáticamente y, para la lógica pura de persistencia, **empíricamente** (extracción de las funciones a un sandbox y ejecución de asserts):

- **No se persiste el password ni ningún secreto.** `AuthSession` es `{provider,email,phone}` y nunca lleva el password; `createMockSession` lo descarta. Payload almacenado verificado = exactamente `{"provider","email","phone"}`, sin la string `secret` ni campo `password`. El test `auth.test.ts` fija este contrato (`not.toContain("secret")`). → mitiga "raw passwords en localStorage". (A02/A07)
- **El estado no-marcado realmente no persiste.** En `handleLogin`, si `rememberMe` es `false` se llama `clearRememberedSession(...)` (borra incluso una sesión recordada previa) y no se escribe nada. (A05)
- **El logout limpia toda la auth persistida.** `handleLogout` → `clearRememberedSession` + resetea `session`, **borra `password` del estado**, `data`, `state`, `error`. Botón "Cerrar sesión" cableado (`type="button"`). → cubre L2 del review previo para esta sesión. (A05)
- **Parseo endurecido contra storage envenenado.** `parseStoredSession` envuelve `JSON.parse` en `try/catch` (JSON corrupto → `null`, no rompe la app), valida forma (provider/email/phone + patrón email + largo de teléfono) y devuelve **solo los 3 campos por whitelist** → un `token`/campo extra inyectado en localStorage se descarta al leer. Verificado empíricamente. (A03/A08)
- **No se loguean secretos.** Sin `console.*` en el componente ni en `auth.ts`.
- **Accesibilidad del checkbox.** `<label htmlFor="remember-me">` + `<input id="remember-me" type="checkbox">` con texto visible; asociación label↔control correcta, click en el texto togglea.
- **Buenas prácticas:** clave versionada (`...v1`), `Storage` inyectado por parámetro (`Pick<Storage,...>`) → testeable; microcopy de consentimiento ("si marcas recordarme, se guarda email y telefono en este navegador"); opt-in por defecto (`rememberMe` inicia en `false`).

---

## 2. Hallazgo medio 🟡

### M1 — PII persistida en `localStorage` sin expiración ni protección frente a XSS (A05 / Ley 18.331)
`persistRememberedSession` guarda email + teléfono (PII) en `localStorage`:
- **Legible por JavaScript** → cualquier XSS en la PWA exfiltra el email y teléfono recordados (la PWA ya tiene CSP con `unsafe-inline`, ver M4 del review general → superficie XSS no nula).
- **Sin TTL** → persiste indefinidamente; en un equipo compartido/kiosco el siguiente usuario reabre la app y la sesión se **auto-restaura** (`useEffect` → `loadRememberedSession`), exponiendo la PII del titular anterior.

No hay token de sesión real, así que el impacto es **divulgación de PII + auto-restauración indebida**, no toma de cuenta. Aun así es PII bajo Ley 18.331.

**Fix solicitado (tratable sin backend):** agregar `expiresAt` al payload y descartar/limpiar al expirar.
```ts
// persist
storage.setItem(KEY, JSON.stringify({ ...session, expiresAt: Date.now() + 30*864e5 }));
// load: si !expiresAt || Date.now() > expiresAt -> clear + return null
```
Mantener el opt-in y el texto de consentimiento (ya presentes).

---

## 3. Hallazgos bajos 🔵

### L1 — `persistRememberedSession` serializa el objeto sesión completo (defensa en profundidad)
`storage.setItem(KEY, JSON.stringify(session))` es seguro **hoy** porque `AuthSession` no tiene secretos, pero es un vector latente: si `AuthSession` gana un `token`/`accessToken` a futuro (p. ej. al cablear NextAuth), se escribiría a `localStorage` automáticamente. La whitelist existe solo en la **lectura**.
**Fix:** whitelistear también en la escritura, espejando el read-side:
```ts
const { provider, email, phone } = session;
storage.setItem(KEY, JSON.stringify({ provider, email, phone /*, expiresAt */ }));
```

### L2 — `.checkbox-row` sin regla CSS (UX/a11y menor)
El `<label className="checkbox-row">` se referencia pero no existe la regla en `src/app/globals.css` → el checkbox queda sin estilo/alineación. No es seguridad. Agregar la regla (layout en fila, gap, área de toque ≥24px para móvil).

---

## 4. Recomendaciones de seguimiento (no bloqueantes del diff, sí del producto)

- **I — Integración / build.** Confirmar que el `auth.ts` final (tras el scaffold RIO-15 que corrió en paralelo) conserva **a la vez** `authOptions` y los helpers mock+remember, y que `npm test` (incl. el test de remember-me) y `tsc --noEmit` pasan en verde. No se pudieron correr aquí (node_modules en instalación). El test ya codifica el contrato de no-secreto.
- **II — Migrar a cookie cuando exista backend real.** Con NextAuth ya operativo (se está scaffoldeando), "recordarme" debe implementarse vía `session.maxAge` + cookie `HttpOnly; Secure; SameSite=Lax`, **no** con este shim en `localStorage`, y eliminar el shim para no dejar una copia de PII legible por XSS. (cubre H2/M4 del review general). Mientras se use `localStorage` no aplican flags de cookie ni hay superficie CSRF, pero tampoco hay protección `HttpOnly`.

---

## 5. Trazabilidad OWASP

| OWASP 2021 | Hallazgos |
|------------|-----------|
| A05 Security Misconfiguration | M1, (L2) |
| A07 Identification & Auth Failures | M1 (auto-restore), §4-II |
| A08 Software & Data Integrity | parseo endurecido (✅), L1 |
| Ley 18.331 (PII) | M1 |

**Conclusión:** `CHANGES_REQUESTED`. La feature es segura en lo crítico (no persiste credenciales, no-marcado no persiste, logout limpia, parseo robusto, accesible). Corregir M1 (expiración de PII) + L1 (whitelist en escritura) + L2 (CSS) y validar build/tests (§4-I) para aprobar.
