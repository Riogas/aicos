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
//   The defaults below were tuned for a heavy individual user on Max-Plan:
//   $15/hr for anthropic ≈ ~30 typical runs/hr before survival kicks in.
//   Adjust by writing a budgets.json and pointing QUOTA_BUDGETS_FILE to it.
const DEFAULT_BUDGETS: Budgets = {
  criticalProvider: "anthropic",
  survivalModels: [
    { cli: "opencode", model: "moonshotai/kimi-k2.6", provider: "moonshot" },
    { cli: "opencode", model: "deepseek/deepseek-v4-flash-free", provider: "opencode-free" },
  ],
  providers: {
    anthropic: { windowSec: 3600, maxCostUsd: 15.0, maxRequests: 200 },
    openai: { windowSec: 3600, maxCostUsd: 8.0, maxRequests: 150 },
    google: { windowSec: 3600, maxCostUsd: 5.0, maxRequests: 150 },
    moonshot: { windowSec: 3600, maxCostUsd: 3.0 },
    xiaomi: { windowSec: 3600, maxCostUsd: 3.0 },
    "opencode-free": { windowSec: 3600, maxRequests: 500 },
  },
  clis: {
    "claude-code": { windowSec: 18000, maxRequests: 200, session: "max-plan" },
    codex: { windowSec: 3600, maxRequests: 150, session: "chatgpt-pro" },
    antigravity: { windowSec: 3600, maxRequests: 200, session: "google-preview" },
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
