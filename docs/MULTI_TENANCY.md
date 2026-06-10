# AICOS — Multi-tenancy

## Where the schema is ready

Paperclip is already company-scoped end-to-end:

- `agents.company_id`, `issues.company_id`, `projects.company_id`,
  `companies.id`, `agent_keys.company_id`.
- Every REST route is `/api/companies/<companyId>/<resource>`.
- Auth tokens are minted per-agent within a company; cross-company
  reads/writes are blocked at the middleware layer (`auth.assertCompanyAccess`).
- The `PAPERCLIP_ALLOW_INTRA_COMPANY_AGENT_MUTATIONS` flag we set in
  `docker-compose.yml` only loosens INTRA-company cross-agent edits (so
  the IT Analyst can comment on the IT Architect's ticket). Cross-company
  is still hard-blocked.

## What today's bridge / dashboard does

Both **assume a single company** because we wire one env var:
`AICOS_COMPANY_ID`. The bridge uses it for:

- `/orchestrate` (where to create new issues),
- `/telegram/webhook` (default project lookup),
- the subtask-promoter (which company's backlog to scan),
- `/admin/registry` (no — the registry file is global, not per-company),
- `/in-flight` (no — runs are tracked in-process, company-agnostic).

The dashboard `/api/flow-state` also reads it as an env var.

## What to do to onboard a second company

### Option A — Separate bridge instances (recommended for now)

One bridge process per company. Each has its own:
- `AICOS_COMPANY_ID`,
- `PAPERCLIP_API_KEY` (the Hermes/CEO key of THAT company),
- `BRIDGE_PORT` (so they don't collide — e.g. `:7100` and `:7110`),
- `registry/agents.json` snapshot (you can share the file but the
  `paperclipAgentId` of each agent has to match the company).

The dashboard talks to ONE bridge by env. If you want a single dashboard
across N companies, run N dashboard instances OR add a `?company=<id>`
query param to `/api/flow-state` and route to the matching bridge.

Pros: no schema or code change, isolation is total.
Cons: N processes; if you scale to dozens of companies the operational
cost grows.

### Option B — One bridge, company-aware routes

Pass `companyId` per-request instead of as an env var:

```ts
// /orchestrate?companyId=<id>  or in the body
// /telegram/webhook?companyId=<id>
// /in-flight?companyId=<id>     // filters by stored runs' companyId
```

That requires:

1. `OrchestrateInput.companyId` becomes the source of truth (already is).
2. Tracker entries get a `companyId` field; `/in-flight` filters by it.
3. Paperclip client is constructed per-request with the company's API key.
   Today the bridge holds ONE key in env. Change to a key-vault lookup:
   ```ts
   const apiKey = await keyVault.getKey(companyId);
   ```
4. The subtask-promoter loop runs N companies in round-robin (or N
   independent timers).

This is the "real" multi-tenant shape. It's a ~1 day refactor.

### Option C — Tenant-scoped via header at the reverse proxy

Caddy strips a `Host` header (`acme.aicos.example.com` →
`X-AICOS-Company: acme-uuid`) and the bridge reads it. Same as Option B
in terms of bridge changes, plus Caddy config.

## What's NOT multi-tenant yet

- **Registry file** (`registry/agents.json`) is one file shared by all
  companies. If two companies have different agents you need to either
  split the file (`registry/<companyId>/agents.json`) or run separate
  bridges (Option A).
- **Quota manager budgets** are global (one set of `criticalProvider`,
  `survivalModels`, per-provider caps). For per-tenant budgets, change
  `loadBudgets()` to accept `companyId` and key the in-memory counters
  by `(companyId, provider)` instead of just `provider`.
- **Policy rules** are global. Same fix: take `companyId` and key the
  ruleset by it.
- **Tool gateway / learning / dashboard**: same picture.

None of those are hard refactors — the schema doesn't need to change at
all. What needs to change is "env-var" → "function arg" for the
companyId, in maybe 30 places across the codebase.

## Recommendation

For now (1 real customer), stay on Option A. When you hit the second
customer:

1. Add `AICOS_COMPANY_ID` lookups in those 30 places to take an arg
   instead.
2. Split `registry/agents.json` into `registry/<companyId>/agents.json`.
3. Run multiple bridges OR do the Option B refactor — whichever you can
   stomach.

Either way the Paperclip schema is already there; you're not paying a
data-model cost for the move.
