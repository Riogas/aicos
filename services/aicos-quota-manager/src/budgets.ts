import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Budgets, budgetsSchema } from "./types.js";

// NOTE on what these numbers mean:
//   These are LOCAL counters tracked by the Quota Manager, NOT the real
//   Anthropic/OpenAI session counters. For Max-Plan subscriptions the only
//   way to see real session usage is the interactive /usage slash command —
//   it isn't exposed via any CLI flag or API. So this budget is a
//   "best-effort guardrail": when local accumulated cost-by-token in the
//   last hour exceeds the cap, the bridge starts routing to fallback
//   providers regardless of what the real Anthropic session actually says.
//
//   Estos defaults estan deliberadamente MUY altos: son un guardrail local,
//   no el contador real de Anthropic/OpenAI, y no queremos rutear fuera de
//   claude por un falso "sin quota". El limite real de Max-Plan (ventana 5h)
//   lo maneja Anthropic y no es visible por CLI/API. Para afinar, escribi un
//   budgets.json y apunta QUOTA_BUDGETS_FILE (ver infra/quota-budgets.json).
const DEFAULT_BUDGETS: Budgets = {
  criticalProvider: "anthropic",
  survivalModels: [
    { cli: "opencode", model: "moonshotai/kimi-k2.6", provider: "moonshot" },
    { cli: "opencode", model: "deepseek/deepseek-v4-flash-free", provider: "opencode-free" },
  ],
  providers: {
    anthropic: { windowSec: 3600, maxCostUsd: 500.0, maxRequests: 100000 },
    openai: { windowSec: 3600, maxCostUsd: 200.0, maxRequests: 50000 },
    google: { windowSec: 3600, maxCostUsd: 200.0, maxRequests: 50000 },
    moonshot: { windowSec: 3600, maxCostUsd: 100.0 },
    xiaomi: { windowSec: 3600, maxCostUsd: 100.0 },
    "opencode-free": { windowSec: 3600, maxRequests: 100000 },
  },
  clis: {
    "claude-code": { windowSec: 18000, maxRequests: 100000, session: "max-plan" },
    codex: { windowSec: 3600, maxRequests: 50000, session: "chatgpt-pro" },
    antigravity: { windowSec: 3600, maxRequests: 50000, session: "google-preview" },
  },
};

export function loadBudgets(filePath: string | undefined, cwd: string = process.cwd()): Budgets {
  if (!filePath) return DEFAULT_BUDGETS;
  const absPath = resolve(cwd, filePath);
  if (!existsSync(absPath)) {
    process.stderr.write(
      `[quota] budgets file not found at ${absPath} — using defaults\n`,
    );
    return DEFAULT_BUDGETS;
  }
  const raw = readFileSync(absPath, "utf-8");
  const parsed = budgetsSchema.parse(JSON.parse(raw));
  return parsed;
}

export { DEFAULT_BUDGETS };
