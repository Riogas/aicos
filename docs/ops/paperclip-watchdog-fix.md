# Paperclip "auto-blocked tickets" — root cause and fix path

## TL;DR

Tickets dispatched to the bridge via Paperclip's `http` adapter end up `blocked`
even when the agent runs successfully. **Root cause is the adapter type, not
the bridge's API call surface.** The `presentation`/`metadata`/`disposition`
fix attempted in commit `<<this branch>>` improved the code quality but does
NOT resolve the auto-blocking. The real fix is migrating agents to the
`process` adapter.

## Symptoms

- Bridge run completes successfully (`exit 0`, output produced, git commit ok).
- Bridge posts comment to Paperclip → 201 Created.
- Bridge calls `PATCH /issues/X { status: "done" }` → **403 Forbidden** because
  Paperclip has already created a `recovery_action` for the issue.
- Issue ends up with `status = "blocked"`, `assignee = CEO`.
- Paperclip surfaces system comments like
  *"Paperclip could not resolve this issue's missing disposition automatically."*

## What actually happens (timeline of a single run)

| t   | Actor      | Event |
|-----|-----------|-------|
| 0s  | Paperclip | Detects assigned ticket → dispatches HTTP adapter → `POST :7100/run` |
| ~1s | Bridge    | Returns 202 Accepted (fire-and-forget). Run begins in setImmediate. |
| ~1s | Paperclip | HTTP adapter is fire-and-forget. Does NOT track exit code or completion. |
| ~1s | Paperclip's heartbeat watchdog | Sees a run was dispatched but no confirmation yet. Creates a recovery_action with `handoffRequired: true`. |
| ~2s | Paperclip | Retries the dispatch 2 more times (default `maxHandoffAttempts: 3`). |
| ~2s | Paperclip | After 3 attempts without confirmation, calls `escalateStrandedAssignedIssue` → ticket goes to `blocked`, assignee → CEO (recovery owner). |
| 12s | Bridge    | Agent finishes work, posts comment OK, attempts `PATCH status=done`. |
| 12s | Paperclip | `assertRecoveryActionResolutionAllowed` rejects → 403. Ticket stays blocked. |

The watchdog wins the race every time because the HTTP adapter cannot signal
completion back to Paperclip.

## What the `presentation`/`metadata` patch tried

`apps/paperclip-bridge/src/paperclip-client.ts` now accepts optional
`presentation` and `metadata` parameters on `postComment` matching Paperclip's
strict schema. `apps/paperclip-bridge/src/run.ts` builds an enriched payload
with `disposition: completed`, run details, etc.

**This was rejected by Paperclip with HTTP 403:**
```
{"error":"Only board users may set structured comment presentation or metadata"}
```

Per Paperclip's source (`server/src/routes/issues.ts:1218-`),
`assertStructuredCommentFieldsAllowed` restricts `presentation` and `metadata`
to board-actor accounts. Agent API keys cannot set them.

The patch is **gated behind `PAPERCLIP_ENRICH_COMMENTS=true`** env var (default
off). It exists for the day vendor unlocks this or if we run as a board-mode
service. With the flag off, the bridge falls back to plain body comments
(unchanged behavior).

## The real fix — switch adapter type to `process`

Paperclip supports an `adapterType: "process"` that spawns a subprocess,
captures its exit code + stdout, and natively tracks completion. The bridge
already supports being invoked as a CLI (`aicos-bridge --prompt <text>`),
though it needs extension for the full process-adapter contract.

### Required work

1. **Bridge CLI mode extension** (~2 hours):
   - Read `PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_COMPANY_ID`,
     `PAPERCLIP_API_KEY`, `PAPERCLIP_WORKSPACE_CWD` from env (already injected
     by Paperclip's process adapter — `buildPaperclipEnv` in vendor source).
   - Fetch the issue via REST API using the auth key.
   - Run `executeRun` exactly as today, but write the final result to stdout
     as JSON (Paperclip parses this for telemetry).
   - Exit 0 on success, non-zero on failure.

2. **Reconfigure 26 agents in Paperclip** (~30 minutes):
   ```sql
   UPDATE agents
   SET
     adapter_type = 'process',
     adapter_config = jsonb_build_object(
       'command', 'aicos-bridge',
       'args', jsonb_build_array('--paperclip-process-mode'),
       'cwd', '/home/jgomez',
       'env', jsonb_build_object()
     )
   WHERE company_id = '83ef9217-4f01-473b-a90f-5cc36152d03b'
     AND adapter_type = 'http';
   ```

3. **Verify**:
   - Trigger a fresh ticket assigned to e.g. IT Architect.
   - Watch Paperclip dispatch the process adapter (visible in container logs).
   - Confirm `heartbeat_runs` row is created with `status: succeeded`,
     `finished_at` set, `exit_code: 0`, `result_json` populated.
   - Confirm ticket transitions cleanly to `done` (or `blocked` only on real
     failure).

### Effort estimate
~3 hours total. The plumbing exists; mostly a matter of wiring CLI args and
env reads in `apps/paperclip-bridge/src/index.ts`.

## Workaround for now

Run the bridge HTTP server as a board-impersonating service (would require
forging a board session cookie — not recommended) OR manually mark blocked
tickets `done` in Paperclip UI when the agent actually completed work
(verify by checking the workspace's git log for the agent's commit).

## References

- `vendor/paperclip/server/src/services/recovery/service.ts:188` — `isExhaustedSuccessfulRunHandoff`
- `vendor/paperclip/server/src/services/recovery/service.ts:2176` — `escalateStrandedAssignedIssue`
- `vendor/paperclip/server/src/routes/issues.ts:1218` — `assertStructuredCommentFieldsAllowed`
- `vendor/paperclip/server/src/adapters/http/execute.ts` — fire-and-forget HTTP adapter
- `vendor/paperclip/server/src/adapters/process/execute.ts` — process adapter with exit-code tracking
- `apps/paperclip-bridge/src/paperclip-client.ts` — bridge HTTP client (enrich gated behind env flag)
