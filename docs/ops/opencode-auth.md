# OpenCode auth setup (R6)

The Quota Manager routes to opencode-fronted providers (Kimi K2.6, MiMo V2.5 Pro,
DeepSeek) when:
- Survival mode kicks in (anthropic/openai/google over budget),
- or a budget-aware route prefers a cheaper model.

For that fallback to actually execute, **opencode must be authenticated** with the
underlying provider. This is a one-time interactive step per host.

## Quick setup

```bash
~/aicos/scripts/setup-opencode-auth.sh
```

This wizard:

1. Verifies `opencode` is installed (`npm install -g opencode-ai` if missing)
2. Calls `opencode auth login <provider>` interactively for each provider you
   choose. opencode prompts for the API key on TTY and persists it in
   `~/.local/share/opencode/auth.json`.
3. Drops an `opencode.json` config in every workspace listed in
   `registry/project-workspaces.json` with permissive flags:
   ```json
   {
     "permission": { "edit": "allow", "bash": "allow", "webfetch": "allow" }
   }
   ```
   **Why:** without this, opencode runs read-only and writes nothing (silent
   failure — F10 finding).
4. Probes each provider with a minimal run to confirm auth works.

## Manual setup (if you prefer)

```bash
# Pick whatever provider keys you have:
opencode auth login moonshot      # Kimi K2.6 — https://platform.moonshot.ai
opencode auth login xiaomi        # MiMo V2.5 Pro — https://platform.xiaomimimo.com
opencode auth login openrouter    # OpenRouter — https://openrouter.ai (1 key, many providers)

# In every workspace your agents touch:
cat > /path/to/workspace/opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "permission": { "edit": "allow", "bash": "allow", "webfetch": "allow" }
}
EOF
```

## Recommended provider mix

| Provider    | What                              | When the Quota Manager picks it          |
|-------------|-----------------------------------|------------------------------------------|
| moonshot    | Kimi K2.6 — long coding, cheap    | Survival mode (anthropic exhausted)      |
| xiaomi      | MiMo V2.5 Pro — long planning     | Cheap alternative to Claude for research |
| openrouter  | Catch-all (kimi/mimo/deepseek)    | If you want ONE key instead of multiple  |
| deepseek    | DeepSeek V4 Flash (free tier)     | Volume / batch summarization             |

Authenticate at least **one** of moonshot/xiaomi/openrouter — otherwise survival
mode has no working fallback and runs will exit 127.

## Verification

After running the wizard or doing manual setup:

```bash
# Trigger survival manually + watch the bridge route to opencode
curl -X POST -H "Content-Type: application/json" \
  -d '{"cooldownSec":300,"reason":"manual test"}' \
  http://localhost:7001/providers/anthropic/down

# Then trigger a run via the bridge:
curl -X POST -H "Content-Type: application/json" \
  -d '{"agentId":"<paperclip-agent-id>","prompt":"Echo OK","runId":"r6-test-001"}' \
  http://localhost:7100/run

# Check bridge journal — should see:
#   [quota] persona=X routed to opencode/moonshotai/kimi-k2.6 (survival)
#   [direct-cli opencode survival $...] opencode run -m moonshotai/kimi-k2.6 ...
journalctl --user -u aicos-bridge.service --no-pager -n 30 | grep -E "quota|direct-cli"

# Clear cooldown after test:
curl -X DELETE http://localhost:7001/providers/anthropic/down
```

## ToS reminder

- Moonshot, Xiaomi, OpenRouter API keys: **you pay per token**. Set Quota
  Manager budgets in `services/aicos-quota-manager/src/budgets.ts` accordingly
  (defaults: $0.50/hour per provider).
- DeepSeek free tier has rate limits — don't volume-blast it.
- Claude Max / Codex Pro / Antigravity Preview: subscription based, ToS allows
  "personal use of the owner". Don't resell.

## Known issues

- **Workspace opencode.json must be present at run time.** If a new workspace is
  added to `registry/project-workspaces.json` AFTER running the wizard, re-run
  the wizard (idempotent — won't overwrite existing configs).
- **opencode's auth file is per-user.** If you run the bridge as a different
  user (or in Docker without bind-mounting `~/.local/share/opencode`), it won't
  see the auths. Today the bridge runs as the same user (jgomez) as the auth,
  so this works.
