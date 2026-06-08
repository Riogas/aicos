import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EvaluateInput, EvaluateResult, Rule, Ruleset } from "./types.js";
import { rulesetSchema } from "./types.js";

/**
 * Default ruleset — sensible safe defaults that mirror the §6.7 example of the
 * pivot spec. The loader reads this when no QUOTA_RULES_FILE / POLICY_RULES_FILE
 * env is set.
 */
export const DEFAULT_RULESET: Ruleset = {
  version: "0.1",
  rules: [
    {
      name: "critical-feature-requires-approval",
      effect: "require_approval",
      when: { bucket: ["critical-feature"] },
      reason: "critical-feature: human gate required",
    },
    {
      name: "sensitive-risk-requires-approval",
      effect: "require_approval",
      when: { riskFlagsAny: ["payments", "auth", "secrets", "pii"] },
      reason: "sensitive risk flag (payments/auth/secrets/pii)",
    },
    {
      name: "production-deploy-requires-approval",
      effect: "require_approval",
      when: { riskFlagsAny: ["production-deploy", "database-migration"] },
      reason: "production deploy / DB migration requires explicit approval",
    },
    {
      name: "destructive-actions-deny-by-default",
      effect: "deny",
      when: { riskFlagsAny: ["destructive"] },
      reason: "destructive action requires explicit human override (use approved=true)",
    },
    {
      name: "high-cost-runs-require-approval",
      effect: "require_approval",
      when: { minEstimatedCostUsd: 5.0 },
      reason: "estimated cost exceeds $5 — human confirmation required",
    },
  ],
};

export function loadRuleset(filePath: string | undefined, cwd = process.cwd()): Ruleset {
  if (!filePath) return DEFAULT_RULESET;
  const abs = resolve(cwd, filePath);
  if (!existsSync(abs)) {
    process.stderr.write(`[policy] ruleset file not found at ${abs} — using defaults\n`);
    return DEFAULT_RULESET;
  }
  const raw = readFileSync(abs, "utf-8");
  return rulesetSchema.parse(JSON.parse(raw));
}

function arrayContains(haystack: readonly string[] | undefined, needle: string | undefined): boolean {
  if (!haystack || haystack.length === 0) return true; // empty list = no filter
  if (!needle) return false;
  return haystack.includes(needle);
}

function anyOf(haystack: readonly string[] | undefined, needles: readonly string[] | undefined): boolean {
  if (!haystack || haystack.length === 0) return true;
  if (!needles || needles.length === 0) return false;
  return haystack.some((h) => needles.includes(h));
}

function allOf(haystack: readonly string[] | undefined, needles: readonly string[] | undefined): boolean {
  if (!haystack || haystack.length === 0) return true;
  if (!needles) return false;
  return haystack.every((h) => needles.includes(h));
}

export function ruleMatches(rule: Rule, input: EvaluateInput): boolean {
  const w = rule.when ?? {};
  if (!arrayContains(w.bucket, input.bucket)) return false;
  if (!arrayContains(w.actions, input.action)) return false;
  if (!arrayContains(w.actorTypes, input.actor.type)) return false;
  if (!arrayContains(w.actorRegistryIds, input.actor.registryId)) return false;
  if (!arrayContains(w.resourceTypes, input.resource?.type)) return false;
  if (!anyOf(w.riskFlagsAny, input.riskFlags)) return false;
  if (!allOf(w.riskFlagsAll, input.riskFlags)) return false;
  if (
    w.minEstimatedCostUsd !== undefined &&
    (input.estimatedCostUsd ?? 0) < w.minEstimatedCostUsd
  ) {
    return false;
  }
  return true;
}

export function evaluate(input: EvaluateInput, ruleset: Ruleset): EvaluateResult {
  // Pre-approved inputs bypass everything (the upstream already collected human OK).
  if (input.approved) {
    return {
      decision: "allow",
      reason: "approved=true (upstream already collected human approval)",
      evaluated: input,
    };
  }

  // 1) deny wins first
  for (let i = 0; i < ruleset.rules.length; i++) {
    const r = ruleset.rules[i]!;
    if (r.effect === "deny" && ruleMatches(r, input)) {
      return {
        decision: "deny",
        reason: r.reason ?? r.name ?? "denied by rule",
        matchedRule: { index: i, name: r.name },
        evaluated: input,
      };
    }
  }
  // 2) require_approval next
  for (let i = 0; i < ruleset.rules.length; i++) {
    const r = ruleset.rules[i]!;
    if (r.effect === "require_approval" && ruleMatches(r, input)) {
      return {
        decision: "require_approval",
        reason: r.reason ?? r.name ?? "approval required",
        matchedRule: { index: i, name: r.name },
        evaluated: input,
      };
    }
  }
  // 3) explicit allow rule
  for (let i = 0; i < ruleset.rules.length; i++) {
    const r = ruleset.rules[i]!;
    if (r.effect === "allow" && ruleMatches(r, input)) {
      return {
        decision: "allow",
        reason: r.reason ?? r.name ?? "explicitly allowed",
        matchedRule: { index: i, name: r.name },
        evaluated: input,
      };
    }
  }
  // 4) default allow
  return {
    decision: "allow",
    reason: "no matching rule — default allow",
    evaluated: input,
  };
}
