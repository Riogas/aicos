# AICOS — User Guide

This guide is for **operators**: humans who want to use AICOS to drive an
AI agent fleet (writing code, designing systems, reviewing diffs, running
QA, etc.) without having to read the codebase.

If you want the architecture / how-it-works, read `README.md` and
`docs/specs/`.

---

## What AICOS does

You hand it a single task in natural language. It:

1. Picks N specialist agents from a roster (analyst, architect,
   implementer, code-reviewer, security-reviewer, QA tester, UX validator,
   marketing strategist, copywriter, …).
2. Creates one Paperclip ticket per agent, wires the dependencies between
   them, and starts the first agent.
3. As each agent finishes, AICOS passes its output into the next agent's
   prompt context (so the architect reads the analyst's spec, the
   implementer reads the architect's plan, etc.).
4. Each agent runs on whichever CLI is healthiest right now: claude /
   codex / agy / kimi / mimo. When claude's session is saturated, the
   fleet keeps running on codex + openweight models automatically.
5. You watch it work in real time on the live tactical view at
   `http://<host>:3000/flow`.

You can trigger it from:
- the orchestrate HTTP endpoint (curl / scripts),
- a Telegram bot (point its webhook at the bridge),
- a Paperclip ticket (Paperclip itself dispatches it).

You can interrupt it via:
- `DELETE /run/:runId` to cancel a specific run,
- `POST /approve { issueId }` to release a run held for approval.

---

## Quickstart

Prereqs: Docker, pnpm, Node 22, Linux/WSL2 host.

1. **Bring up the stack**
   ```bash
   cd ~/aicos
   docker compose -f infra/docker-compose.yml up -d
   ```
   Starts Postgres, Redis, Qdrant, Paperclip, plus the AICOS services
   (quota, policy, gateway, learning, dashboard).

2. **Configure secrets** (see `.env.example`)
   ```bash
   cp infra/.env.example infra/.env
   $EDITOR infra/.env   # set PAPERCLIP_API_KEY, AICOS_COMPANY_ID, …
   ```

3. **Start the bridge** (runs on host, not in Docker, so it can spawn
   claude/codex/agy CLIs)
   ```bash
   systemctl --user enable --now aicos-bridge
   ```

4. **Set a dashboard token** (optional but recommended)
   ```bash
   echo 'AICOS_DASHBOARD_TOKEN=pick-a-long-secret' >> ~/.config/systemd/user/aicos-dashboard.service
   systemctl --user daemon-reload
   systemctl --user restart aicos-dashboard
   ```

5. **Open the live tactical view**
   ```
   http://localhost:3000/flow
   ```
   First time: it'll redirect to `/login`. Paste the token.

---

## Send AICOS a task

### From the terminal
```bash
curl -X POST http://localhost:7100/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "taskDescription": "Write the spec, design, implementation plan, and tests for a remember-me checkbox on the login page",
    "projectId": "<your-paperclip-project-id>",
    "triggeredBy": "manual"
  }'
```
Response includes `parentIdentifier` (the parent ticket) and the
identifiers of every subtask AICOS created.

### From Telegram
1. Create a bot with `@BotFather`, save its token.
2. Set its webhook to your bridge:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-host>/api/bridge/telegram/webhook" \
     -d "secret_token=<long-shared-secret>"
   ```
3. On the bridge:
   ```bash
   echo 'AICOS_TELEGRAM_SECRET=<long-shared-secret>' >> /etc/aicos/bridge.env
   echo 'AICOS_DEFAULT_PROJECT_ID=<your-paperclip-project-id>' >> /etc/aicos/bridge.env
   systemctl restart aicos-bridge
   ```
4. Talk to the bot. Every message becomes an `[telegram]`-tagged parent
   in Paperclip and the dashboard's Operator node lights up.

### From Paperclip
Just create or assign a ticket to an AICOS agent. The agent's process
adapter will dispatch a run, the bridge picks it up, and the tracker
shows it on the dashboard.

---

## Watching it work

**Live tactical view** (`/flow`): a Jarvis-style topology. From left to
right: Operator → Hermes → Paperclip → Bridge → Workers (the 26 agents) →
CLIs (claude/codex/agy/opencode) → Providers (anthropic/openai/google/
moonshot/xiaomi/opencode-free).

Below the bridge: side services (Quota / Policy / Memory / Learning /
Tool Gateway). They light up only when really used.

Top-right: a TELEMETRY panel with run count, success rate, daily spend,
and the active target. Below it: SUBTASK TREE — each orchestrator parent
with the children currently in flight under it.

Each worker box shows its current stage when active: `dispatched →
memory-retrieve → quota-select → cli-running → posting-result → done`.
Stage transitions arrive in real time via SSE (no 2s polling delay).

---

## Common operations

### "An agent is using claude, but I'd rather it use codex right now"

Mark anthropic down for an hour:
```bash
curl -X POST http://localhost:7001/providers/anthropic/down \
  -d '{"cooldownSec": 3600, "reason": "manual override"}'
```
The quota manager will skip claude for that window; the bridge's fallback
chain rotates everyone to codex / agy / kimi automatically.

To clear:
```bash
curl -X DELETE http://localhost:7001/providers/anthropic/down
```

### "I want this run to stop"

```bash
curl -X DELETE 'http://localhost:7100/run/<runId>?reason=changed%20my%20mind'
```
Posts a cancellation comment on the ticket and PATCHes it to `cancelled`.
The subprocess keeps running briefly but its output goes nowhere useful.

### "Policy asked for approval — how do I approve?"

The held ticket gets an `⏸ Awaiting approval` comment. To release:
```bash
curl -X POST http://localhost:7100/approve \
  -H "Content-Type: application/json" \
  -d '{"issueId": "<ticket-uuid>", "approverNote": "looks good"}'
```
The run relaunches with `approved=true`, skipping the policy gate, and
the approver note shows up as a comment.

### "Clear out test debris from the DB"

```bash
bash scripts/cleanup_tickets.sh --apply --days 30
```
Hides (not deletes) done/cancelled/blocked tickets older than N days,
plus anything whose title looks like a test marker.

### "I want to add a new agent"

Edit `registry/agents.json`, add a new entry with `id`, `name`,
`department`, `capabilities`, `preferredModel`, `fallbackChain`,
`paperclipAgentId`. Then:
```bash
curl -X POST http://localhost:7100/admin/reload-registry
```
No restart needed.

To make the new agent dispatchable by Paperclip, also run
`scripts/onboard-agents.mjs` (creates the Paperclip agent + adapter_config).

---

## Troubleshooting

**The dashboard shows everything dim even though something is running.**
Bridge is probably down. Check `systemctl --user status aicos-bridge`
and `curl http://localhost:7100/health`. If healthy, check
`curl http://localhost:7100/in-flight` — empty means the tracker doesn't
know about any runs (probably Paperclip's process adapter is spawning
runs that aren't reaching the bridge's `/stage` endpoint).

**Anthropic provider shows 100% saturated locally but `/usage` in Claude
Code shows 30%.** Those are two different counters — the dashboard's bar
is the bridge's LOCAL accounting (sum of token-cost over the last hour),
not Anthropic's session counter. They will not match. Hover the provider
box for the tooltip explanation.

**A subtask is stuck in `backlog` forever.** Its blocker hasn't reached
`done` or `cancelled`. Check the blocker's status in Paperclip; the
subtask-promoter scans every 5s and will move it as soon as it sees the
blocker complete.

**The parent of a pipeline is stuck in `blocked`.** Paperclip's watchdog
escalated it. If all its children are `done`, the promoter will try to
close it but may fail with a 403 — the watchdog stamped a recovery
action owned by an admin account. Close it manually in Paperclip's UI
for now; the parent-heartbeat (60s ticks) is designed to prevent this
in future pipelines.

**A run failed and I can't tell which CLI was the problem.**
```bash
curl http://localhost:7003/recent | jq '.items[] | select(.ticketId=="RIO-XX")'
```
Returns every attempt for that ticket with cli/model/provider/success/
failureReason.

---

## Scaling out

The bridge is **single-process by default** but designed to scale:

- Run queue is Redis-backed (BullMQ) when `REDIS_URL` is set; you can
  spawn multiple bridge processes, all pulling from the same queue.
  Concurrency cap per-process via `BRIDGE_RUN_CONCURRENCY` (default 4).
- Tracker state lives in Redis when configured, so a bridge restart
  doesn't drop in-flight runs.
- Postgres + Paperclip are already the system of record; you can add
  read replicas later for the dashboard's heavy read traffic.

For multi-tenancy (more than one Paperclip company), the schema is
already company-scoped. Each tenant gets its own:
- `AICOS_COMPANY_ID` value (and matching Paperclip API key),
- bridge process (or a routed virtual host),
- entries in `registry/agents.json` (agents are per-company).

The dashboard `/api/flow-state` route is hard-coded to one company today;
in a multi-tenant deploy it accepts `?company=<id>` as a query param and
proxies the appropriate bridge / paperclip key.

---

## Where to look in the code

| Thing | File |
|---|---|
| Orchestrator (decompose + create tree) | `apps/paperclip-bridge/src/orchestrator.ts` |
| Subtask promoter (backlog→todo + context inject + parent reconcile) | `apps/paperclip-bridge/src/subtask-promoter.ts` |
| Per-run executor + retry-with-fallback | `apps/paperclip-bridge/src/run.ts` |
| Stage tracker + SSE | `apps/paperclip-bridge/src/in-flight-tracker.ts` |
| BullMQ queue | `apps/paperclip-bridge/src/run-queue.ts` |
| Telegram + Approve + Cancel endpoints | `apps/paperclip-bridge/src/server.ts` |
| Live tactical view | `apps/dashboard/src/app/flow/` |
| Quota manager | `services/aicos-quota-manager/src/` |
| Policy engine | `services/aicos-policy-engine/src/` |
| Tool gateway | `services/aicos-tool-gateway/src/` |
| Learning service | `services/aicos-learning/src/` |
