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

## Qué hace el wizard

En Windows el wizard:
1. Verifica/instala WSL2 con Ubuntu 24.04
2. Habilita systemd dentro de WSL
3. Copia el repo dentro de WSL
4. Continúa el wizard dentro de WSL como si fuera Linux

## Qué configura

| Módulo | Pasos del wizard |
|---|---|
| **Preflight** | Docker, Node 22, pnpm, Python 3.10+, conexión |
| **Vendor** | clone upstream de Paperclip + aplicar `installer/patches/*.patch` |
| **Hermes** | install CLI, OAuth login o API keys de providers, modo silencioso |
| **CLIs (opcional)** | claude, codex, agy/gemini, opencode — cada uno con OAuth o API key |
| **Telegram** | via Hermes-gateway o bot dedicado con webhook al bridge |
| **Paperclip** | crear company + claim Hermes agent + generar agent-keys.json |
| **Services** | levantar docker compose, instalar systemd units, healthcheck |

## Diseño

- `install.sh` / `install.ps1`: entrypoints que preparan el host
- `wizard.py`: cerebro común, escribe configs, hace preguntas
- `lib/`: módulos por sección (preflight, hermes, clis, telegram, paperclip, services)
- `templates/`: plantillas `.env`, systemd units, etc.

Cada módulo expone `def configure(state: dict) -> dict` que muta `state` con
lo que el usuario fue eligiendo. Al final `services.bring_up(state)` materializa
todo en archivos + arranca containers + verifica.

## Salidas

Después del wizard tenés:

```
~/aicos/
  .secrets/
    paperclip-claim-response.json   # company + Hermes API key
    agent-keys.json                  # 26 agent tokens
    api-keys.env                     # opcional, si elegiste API keys
  infra/.env                          # docker compose env
  registry/agents.json                # 26 agentes onboarded
  registry/project-workspaces.json    # tus proyectos
```

Servicios corriendo:

- Postgres :5432
- Redis :6379
- Qdrant :6333
- Paperclip :3100
- Bridge :7100 (systemd)
- Dashboard :3000 (systemd) — `http://localhost:3000/flow`
- Quota/Policy/Learning/Gateway :7001-7004
- Caddy :443 (opcional, profile=proxy)

## Re-correr

El wizard es **idempotente** — re-ejecutarlo:
- Detecta lo ya instalado y solo pregunta lo que falta
- Permite re-rotar API keys
- Permite agregar/quitar CLIs sin volver a empezar
- Permite migrar de OAuth a API key (y al revés)
