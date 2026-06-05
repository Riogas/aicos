import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Budgets, budgetsSchema } from "./types.js";

const DEFAULT_BUDGETS: Budgets = {
  criticalProvider: "anthropic",
  survivalModels: [
    { cli: "opencode", model: "moonshotai/kimi-k2.6", provider: "moonshot" },
    { cli: "opencode", model: "deepseek/deepseek-v4-flash-free", provider: "opencode-free" },
  ],
  providers: {
    anthropic: { windowSec: 3600, maxCostUsd: 2.0, maxRequests: 100 },
    openai: { windowSec: 3600, maxCostUsd: 1.0, maxRequests: 100 },
    google: { windowSec: 3600, maxCostUsd: 0.5, maxRequests: 100 },
    moonshot: { windowSec: 3600, maxCostUsd: 0.5 },
    xiaomi: { windowSec: 3600, maxCostUsd: 0.5 },
    "opencode-free": { windowSec: 3600, maxRequests: 200 },
  },
  clis: {
    "claude-code": { windowSec: 18000, maxRequests: 80, session: "max-plan" },
    codex: { windowSec: 3600, maxRequests: 50, session: "chatgpt-pro" },
    antigravity: { windowSec: 3600, maxRequests: 100, session: "google-preview" },
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
