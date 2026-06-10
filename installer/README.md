# AICOS Installer

Wizard interactivo end-to-end. Funciona en:

- **Linux** (Ubuntu 22.04+ / Debian 12+ / WSL2 Ubuntu): `bash install.sh`
- **Windows 10/11**: `.\install.ps1` desde PowerShell con Admin

## One-liner desde una máquina sin nada instalado

**Linux / WSL Ubuntu**

```bash
curl -fsSL https://raw.githubusercontent.com/Riogas/aicos/main/installer/bootstrap.sh | bash
```

**Windows** (PowerShell como Administrador)

```powershell
irm https://raw.githubusercontent.com/Riogas/aicos/main/installer/bootstrap.ps1 | iex
```

Ambos bootstrap:
1. Verifican / instalan `git` y `curl`.
2. Clonan el repo a `~/aicos` (o `%USERPROFILE%\aicos`).
3. Encadenan a `install.sh` / `install.ps1` — que arranca el wizard.

Si el repo ya existe en el destino, hace `git fetch + reset --hard` para tomar lo último, y vuelve a correr el wizard.

En Windows el wizard además:
1. Verifica/instala WSL2 con Ubuntu 24.04
2. Habilita systemd dentro de WSL
3. Copia el repo dentro de WSL
4. Continúa el wizard dentro de WSL como si fuera Linux

## Qué configura

| Fase | Pasos del wizard |
|---|---|
| **preflight** | Docker, Node 20+, pnpm, estructura del repo |
| **vendor** | clone de Paperclip pinned a SHA conocido + `installer/patches/*.patch` |
| **hermes** | install oficial de hermes-agent (NousResearch), quiet-mode, auth |
| **clis** (opcional) | claude / codex / agy (Antigravity) / opencode — OAuth o API key |
| **telegram** | vía Hermes-gateway o bot dedicado con webhook al bridge |
| **paperclip** | board token (aprobación browser 1 vez) → company → agente "AICOS Hermes" + key → invite → onboard 26 especialistas auto-aprobados → adapter `process` |
| **workspaces** | primer proyecto en Paperclip + mapping projectId→cwd local |
| **services** | env files, docker compose, systemd user units, healthcheck |

### El paso de aprobación browser (fase paperclip)

Paperclip corre en modo `authenticated`/`private`: las mutaciones board
necesitan un token. El wizard crea un **CLI-auth challenge** y te muestra
dos URLs:

1. `http://localhost:3100` — registrate (el primer usuario de la instancia
   queda como admin)
2. la `approvalUrl` del challenge — click en **Approve**

El wizard pollea hasta la aprobación y de ahí en más todo es automático
(company, agentes, invites, approvals, keys).

## Quién corre dónde

- **docker compose** (`infra/docker-compose.yml`): postgres, redis, qdrant,
  paperclip, quota-manager (7001), policy-engine (7002), learning (7003),
  tool-gateway (7004). El compose también define un servicio `aicos-dashboard`
  pero el wizard NO lo levanta (clash :3000 con el de systemd).
- **systemd --user** (host): `aicos-bridge` (7100), `aicos-dashboard` (3000),
  `hermes-gateway`. Los units viven en `infra/systemd/` y el wizard los copia
  a `~/.config/systemd/user/`. El bridge corre en el host porque spawnea los
  CLIs (claude/codex/agy/opencode) con tus credenciales locales.
- La red del compose tiene subnet fija (`172.28.0.0/16`) para que
  `host.docker.internal` siempre apunte al gateway correcto. Override:
  `AICOS_DOCKER_SUBNET` / `AICOS_DOCKER_GATEWAY` en `infra/.env`.

## Diseño

- `install.sh` / `install.ps1`: entrypoints que preparan el host
- `wizard.py`: cerebro común — loop de fases, estado resumible
- `lib/`: un módulo por fase (`preflight`, `vendor`, `hermes`, `clis`,
  `telegram_setup`, `paperclip_setup`, `workspaces`, `services_setup`)
- `patches/`: patches que el wizard aplica sobre `vendor/paperclip`

Cada módulo expone `def configure(state: dict) -> dict` que muta `state` con
lo que el usuario fue eligiendo. El estado se persiste en
`.secrets/wizard-state.json` después de cada fase (resumible con Ctrl-C).

## Salidas

Después del wizard tenés:

```
~/aicos/
  .secrets/
    wizard-state.json                # estado resumible del wizard (0600)
    paperclip-claim-response.json    # key del agente "AICOS Hermes" (bridge identity)
    agent-keys.json                  # 26 agent tokens
    agent-onboarding-state.json      # progreso del onboarding (resumible)
  infra/.env                         # docker compose env
  infra/.env.bridge                  # env del bridge (systemd EnvironmentFile)
  registry/agents.json               # 26 agentes con paperclipAgentId reales
  registry/project-workspaces.json   # tus proyectos
```

Servicios corriendo:

- Postgres :5432 / Redis :6379 / Qdrant :6333 (docker)
- Paperclip :3100 (docker) — ticket board UI
- Quota :7001 / Policy :7002 / Learning :7003 / Gateway :7004 (docker)
- Bridge :7100 (systemd) — orchestrate/telegram/approve/SSE/metrics
- Dashboard :3000 (systemd) — `http://localhost:3000/flow`
- Caddy :443 (opcional, `--profile proxy`)

## Re-correr

El wizard es **idempotente** — re-ejecutarlo:
- Detecta lo ya instalado y solo pregunta lo que falta
- Permite re-rotar API keys
- Permite agregar/quitar CLIs o workspaces sin volver a empezar
- `--skip <fase>` saltea una fase puntual; `--reset` arranca de cero
