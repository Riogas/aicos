# R3 — Quota Manager (adapted to `~/aicos`)

> Status: BUILDING — 2026-06-05
> Adapts F12 spec (`docs/superpowers/specs/2026-05-27-...phase12-quota-manager-design.md` in OLD `~/ai-company-os`) to the NEW architecture where Hermes-Nous is the brain, the bridge spawns CLIs directly via `cli-direct.ts`, and there is **no** Router/Planner/StageRunner of our own.

## Why this differs from the F12 spec

| F12 (old arch) | R3 (new arch) |
|---|---|
| `@aicompany/router` planner uses `resolveStageModelQuota` mid-pipeline | Bridge `direct-cli` flow uses `selectModel` from quota service before spawn |
| `resolveStageModel` returns `{driver, model, provider}` | Bridge has `registry.ts.preferredModel` + `fallbackChain` per agent → calls `GET /select?candidates=...` and gets `{cli, model, provider}` |
| Stage-runner records usage after each stage | Bridge `cli-direct.ts` records usage after each invocation (cost from Claude `--total_cost_usd`, opencode stream `step_finish.part.cost`) |
| Local TypeScript package consumed by routers | **Standalone Fastify HTTP service** in `services/aicos-quota-manager`, MCP wrapper later (user chose: HTTP first) |
| Plan-time + per-run | Pre-spawn + post-run (bridge is the only consumer for now) |

## Architecture

```
[Bridge]                           [Quota Manager :7001]            [Redis]
   │                                       │                          │
   │ before agent spawn:                   │                          │
   ├──GET /select?role=it-architect────────▶                          │
   │  candidates=[                         │ Read counters per         │
   │    {cli:claude,model:opus-4-7,prov:anthropic},                    │
   │    {cli:claude,model:sonnet-4-6,prov:anthropic},                  │
   │    {cli:codex,model:gpt-5.5,prov:openai},                         │
   │    {cli:opencode,model:kimi,prov:moonshot}                        │
   │  ]                                    ├──HGETALL quota:{prov}────▶
   │                                       │ Pick first available     │
   │  ◀────{cli,model,provider,reason}─────│ (or SURVIVAL fallback)   │
   │                                       │                          │
   │ spawn cli, run agent, capture cost    │                          │
   │                                       │                          │
   │ after:                                │                          │
   ├──POST /usage─────────────────────────▶│                          │
   │  {provider, costUsd, requests:1}      ├──INCRBYFLOAT + EXPIRE──▶ │
   │                                       │                          │
```

## Endpoints

### `POST /usage`
Records actual usage for a provider after a run.
```json
{
  "provider": "anthropic",          // required
  "costUsd": 0.034,                 // required (0 if best-effort failed)
  "requests": 1,                    // optional, default 1
  "tokens": { "input": 1234, "output": 567, "cached": 0 }, // optional, telemetry only
  "model": "claude-opus-4-7",       // optional, telemetry
  "agentRegistryId": "it-architect",// optional, telemetry
  "ticketId": "RIO-13"              // optional, telemetry (paperclip identifier)
}
```
Returns `{ ok: true, windowReset: "2026-06-05T16:00:00Z" }`.

### `GET /select`
Picks the first available model from a candidate list.
```
GET /select?role=it-architect&candidates=<base64-json-array>&task=critical
```
Body of candidates:
```json
[
  {"cli":"claude","model":"claude-opus-4-7","provider":"anthropic"},
  {"cli":"claude","model":"claude-sonnet-4-6","provider":"anthropic"},
  {"cli":"opencode","model":"moonshotai/kimi-k2.6","provider":"moonshot"}
]
```
Returns `{ chosen: {cli,model,provider}, reason: "preferred|fallback|survival", survivalActive: false }`.
Returns 503 if no candidate available and survival exhausted.

### `GET /status`
Snapshot of all providers.
```json
{
  "survivalActive": false,
  "criticalProvider": "anthropic",
  "providers": {
    "anthropic": {
      "windowSec": 3600,
      "usedCostUsd": 1.42,
      "requests": 23,
      "budget": {"maxCostUsd": 2, "maxRequests": 100},
      "available": true,
      "windowResetAt": "2026-06-05T16:00:00Z"
    },
    "moonshot": {...},
    "openai": {...}
  }
}
```

### `POST /providers/:name/down` (admin)
Manually mark a provider down for N seconds.
```json
{ "cooldownSec": 600, "reason": "rate-limit error from API" }
```

### `GET /health`
`{ status: "ok", redis: "connected" }`.

## Config

`services/aicos-quota-manager/budgets.json`:
```json
{
  "criticalProvider": "anthropic",
  "survivalModels": [
    {"cli":"opencode","model":"moonshotai/kimi-k2.6","provider":"moonshot"},
    {"cli":"opencode","model":"deepseek/deepseek-v4-flash-free","provider":"opencode-free"}
  ],
  "providers": {
    "anthropic":   {"windowSec": 3600, "maxCostUsd": 2.0,  "maxRequests": 100},
    "openai":      {"windowSec": 3600, "maxCostUsd": 1.0,  "maxRequests": 100},
    "google":      {"windowSec": 3600, "maxCostUsd": 0.5,  "maxRequests": 100},
    "moonshot":    {"windowSec": 3600, "maxCostUsd": 0.5},
    "xiaomi":      {"windowSec": 3600, "maxCostUsd": 0.5},
    "opencode-free":{"windowSec": 3600, "maxRequests": 200}
  },
  "clis": {
    "claude-code":   {"windowSec": 18000, "maxRequests": 80,  "session":"max-plan"},
    "codex":         {"windowSec": 3600,  "maxRequests": 50,  "session":"chatgpt-pro"},
    "antigravity":   {"windowSec": 3600,  "maxRequests": 100, "session":"google-preview"}
  }
}
```

Env (`.env`):
```dotenv
REDIS_URL=redis://localhost:6379
QUOTA_PORT=7001
QUOTA_BUDGETS_FILE=/etc/aicos/budgets.json   # or relative path
QUOTA_ENABLED=true                            # if false, /select always returns first candidate
```

## Redis keys

| Key | Type | TTL | Use |
|---|---|---|---|
| `quota:provider:{name}:cost`     | string (float)| windowSec | INCRBYFLOAT after each /usage |
| `quota:provider:{name}:reqs`     | string (int)  | windowSec | INCR after each /usage |
| `quota:provider:{name}:down`     | string        | cooldownSec | SET when admin marks down |
| `quota:cli:{name}:reqs`          | string (int)  | windowSec | INCR per CLI spawn |
| `quota:audit:{date}`             | list (JSON)   | 7 days | Recent usage entries (telemetry) |

## Hard rules (§8.5 of pivot spec, hardcoded in `/select`)

- Reject ANY request that would push total budget across all providers > $10/hour without `bypassRule=true` (admin only).
- Never pick Opus for `task=trivial|bug-fix`.
- Never pick Antigravity for tasks with workspace size < some threshold (heuristic; default true unless `task=large-context`).
- Always prefer providers where cached prompt windows are available (out of scope for v1, log warning).
- Always prefer cheap APIs (kimi/mimo/deepseek) over expensive CLIs (Claude Max) for `task=trivial`.

## Survival mode

Active when `isAvailable(criticalProvider) === false`. While active:
- `/select` iterates `survivalModels` FIRST.
- Then preferred + fallback (in case survival exhausted too).
- 503 with `{ survivalExhausted: true }` if no candidate works.
- Telegram notification: published to `aicos:events` Redis pub/sub channel (Hermes picks it up via its event bus).

Auto-deactivates when criticalProvider window TTL expires (Redis auto-clears the cost counter).

## Build sequence

1. **T1 — Package scaffold** (1h)
   - `services/aicos-quota-manager/` with Fastify + ioredis + zod
   - `package.json`, `tsconfig.json`, `tsup.config.ts` (mirrors bridge)
   - `src/index.ts`: CLI entry (`--serve --port 7001`)
   - `src/server.ts`: Fastify app w/ `/health`
   - `src/budgets.ts`: budgets.json loader + zod schema
   - `src/quota.ts`: `QuotaManager` interface + `RedisQuotaManager` + `InMemoryQuotaManager`
   - Standalone build (no DB migration, no external deps beyond Redis)

2. **T2 — Core logic + endpoints** (2h)
   - `recordUsage` (Redis INCRBYFLOAT + EXPIRE)
   - `isAvailable` (read keys, compare budget)
   - `markDown` / `clearDown`
   - `snapshot` (HMGET multiple providers)
   - `survivalActive` derived state
   - `selectModel(candidates, opts)` — picks first available, survival overlay
   - Hard rules wire-in
   - Fastify routes wire-in
   - Smoke tests: in-memory fake, check budget flips at threshold

3. **T3 — Bridge integration** (1h)
   - `apps/paperclip-bridge/src/quota-client.ts`: thin HTTP client (`GET /select`, `POST /usage`)
   - `cli-direct.ts` before-spawn: build candidate list from `registry.ts.preferredModel + fallbackChain`, call `selectModel`, use returned `{cli,model,provider}`
   - `cli-direct.ts` after-spawn: extract `costUsd` from CLI output (claude stream-json `total_cost_usd`; opencode `step_finish.part.cost`) → `POST /usage`
   - Env: `QUOTA_SERVICE_URL=http://localhost:7001` (optional; if absent, skip → no-op = today's behavior)

4. **T4 — Docker + e2e** (1h)
   - Add `aicos-quota-manager` service to `infra/docker-compose.yml`
   - Wire bridge env to point at it (`QUOTA_SERVICE_URL=http://aicos-quota-manager:7001`)
   - e2e demo: run 1 agent via bridge → Redis shows counters subscribed → `/status` reflects cost → mark anthropic down via `/providers/anthropic/down` → next spawn picks moonshot fallback

## Out of scope (next iteration)

- MCP wrapper (Hermes consults Quota Manager as MCP tool) — R3.5
- Dashboard surface — R7
- Per-tenant budgets — monetization
- Pre-flight cost estimate (predict before spawning) — R3.5
- Cache-window-aware routing — out
- CLI cost capture from `claude` Max plan sessions (no API cost emitted — track requests only) — limitation noted
- Persisted historical telemetry (only Redis 7-day audit list) — R7

## Honest risks

- **Opencode cost capture** is best-effort (F10 finding). For opencode-fronted providers (moonshot/xiaomi/deepseek), budgets use `maxRequests` as primary signal until cost capture is reliable.
- **Claude Code Max plan** doesn't emit per-message cost (subscription session) — track `maxRequests` per window only.
- Two workers spawning agents concurrently could each see "available" at the same instant and both spawn → over-budget by 1 message. Acceptable race; future: atomic check-and-INCR.
- F12 spec mentions `Stage += provider`; we don't have Stage in this arch — provider lives on the candidate object and gets recorded with usage.
