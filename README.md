# AICOS — AI Company OS

A monorepo for running AI agents as a "company": quota-aware routing, policy-gated
actions, outcome learning, and a read-only ops dashboard. Agent traffic flows through
the **Paperclip Bridge**, which consults the supporting services before acting.

## Components

| Package | Role |
| --- | --- |
| `apps/paperclip-bridge` | Bridge between Paperclip and the Hermes Agent (CLI + HTTP `--serve`). |
| `apps/dashboard` | Next.js 14 read-only ops surface (quota / runs / lessons). |
| `services/aicos-quota-manager` | Tracks per-provider quota in Redis; decides routing. |
| `services/aicos-policy-engine` | Rule-based authz: approve / block / pass-through. |
| `services/aicos-tool-gateway` | Proxy + audit + policy-gating for agent actions. |
| `services/aicos-learning` | Captures run outcomes; exposes `/best-for` rankings. |

## Stack

- **Node.js ≥ 20**, **TypeScript**, **pnpm 9** workspaces
- **Next.js 14** (App Router) for the dashboard
- **tsup** / **tsx** for service builds and dev
- **PostgreSQL 16**, **Redis 7**, **Qdrant** as backing stores (via Docker)

## Run locally

```bash
pnpm install                       # install workspace deps
docker compose -f infra/docker-compose.yml up -d   # postgres / redis / qdrant
pnpm dev                           # run all packages in watch mode
```

The dashboard is served at http://localhost:3000. Individual packages can be run
with `pnpm --filter <name> dev`. Useful root scripts: `pnpm build`, `pnpm typecheck`.
