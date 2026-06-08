# AICOS — vendor patches

Patches we apply to `vendor/paperclip` after cloning. The vendor dir is git-ignored
in this repo (it's a sub-repo of upstream Paperclip), so we cannot version the
modifications inside it — we keep them here as standalone `.patch` files.

## How to apply

```bash
cd vendor/paperclip
git apply ../../infra/patches/paperclip-allow-intra-company-mutations.patch
docker compose -f ../../infra/docker-compose.yml build paperclip
docker compose -f ../../infra/docker-compose.yml up -d paperclip
```

## Active patches

### `paperclip-allow-intra-company-mutations.patch` (R5)

**File:** `server/src/routes/issues.ts` (function `assertAgentIssueMutationAllowed`)

**What:** Adds an opt-in escape hatch — when env `PAPERCLIP_ALLOW_INTRA_COMPANY_AGENT_MUTATIONS=true`,
any agent of the same company can mutate (comment, status change) any issue. Without the env, behavior
is identical to upstream (assignee-only).

**Why:** Our bridge spawns worker agents (Architect → Implementer → Security Reviewer) for tickets
that may be assigned to a meta-agent (Hermes / CEO). The workers need to comment back the result and
update status. Multi-tenant safety stays because `assertCompanyAccess` upstream still rejects
cross-company actors. Audit trail lives in the comment body (which always includes the real
worker agent name — see `apps/paperclip-bridge/src/run.ts` for the `_(IT Architect via direct-cli)_`
suffix pattern).

**Activation:** `infra/docker-compose.yml` already sets `PAPERCLIP_ALLOW_INTRA_COMPANY_AGENT_MUTATIONS: "true"`
on the `paperclip` service. To revert: remove that env var and rebuild.
