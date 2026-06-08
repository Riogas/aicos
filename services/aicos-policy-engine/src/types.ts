import { z } from "zod";

/**
 * Policy decisions:
 *   - allow:    proceed without intervention
 *   - require_approval: hold until a human approves via Telegram/UI
 *   - deny:     reject the action entirely
 */
export const decisionSchema = z.enum(["allow", "require_approval", "deny"]);
export type Decision = z.infer<typeof decisionSchema>;

/**
 * Risk flags surfaced by the upstream triage step. The bridge or Hermes
 * sends them along with the task; the policy engine uses them to match rules.
 */
export const riskFlagSchema = z.enum([
  "payments",
  "auth",
  "secrets",
  "pii",
  "database-migration",
  "external-api",
  "destructive",
  "production-deploy",
]);
export type RiskFlag = z.infer<typeof riskFlagSchema>;

export const actorSchema = z.object({
  type: z.enum(["agent", "user", "system"]),
  id: z.string(),
  registryId: z.string().optional(),
  department: z.string().optional(),
  companyId: z.string().optional(),
});
export type Actor = z.infer<typeof actorSchema>;

export const resourceSchema = z.object({
  type: z.enum(["ticket", "workspace", "deploy", "model-run", "tool-call"]),
  id: z.string().optional(),
  workspaceCwd: z.string().optional(),
  projectId: z.string().optional(),
  ticketIdentifier: z.string().optional(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const evaluateInputSchema = z.object({
  actor: actorSchema,
  action: z.string(),
  resource: resourceSchema.optional(),
  bucket: z
    .enum(["trivial", "bug-fix", "small-feature", "large-feature", "critical-feature"])
    .optional(),
  riskFlags: z.array(riskFlagSchema).default([]),
  /** Estimated cost of executing this action — used by rules that cap budget. */
  estimatedCostUsd: z.number().nonnegative().optional(),
  /** True when the upstream already collected an approval. */
  approved: z.boolean().optional(),
});
export type EvaluateInput = z.infer<typeof evaluateInputSchema>;

export interface EvaluateResult {
  decision: Decision;
  reason: string;
  matchedRule?: { index: number; name?: string };
  /** Echo of original input for trace/audit purposes. */
  evaluated: EvaluateInput;
}

/**
 * Rule shape — matches by ANY/ALL of these conditions. A condition is
 * "matching" when the input has the same value (or contains the listed
 * riskFlag/action). A rule with empty `when` is a catch-all.
 *
 * Rule eval order:
 *   1. First matching rule with effect="deny" wins (deny short-circuits).
 *   2. Else first matching with "require_approval" wins.
 *   3. Else "allow".
 *
 * Default if no rule matches: allow.
 */
export const ruleSchema = z.object({
  name: z.string().optional(),
  effect: decisionSchema,
  when: z
    .object({
      bucket: z.array(z.string()).optional(),
      actions: z.array(z.string()).optional(),
      riskFlagsAny: z.array(z.string()).optional(),
      riskFlagsAll: z.array(z.string()).optional(),
      actorTypes: z.array(z.string()).optional(),
      actorRegistryIds: z.array(z.string()).optional(),
      resourceTypes: z.array(z.string()).optional(),
      minEstimatedCostUsd: z.number().nonnegative().optional(),
    })
    .default({}),
  reason: z.string().optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const rulesetSchema = z.object({
  version: z.string().default("0.1"),
  rules: z.array(ruleSchema).default([]),
});
export type Ruleset = z.infer<typeof rulesetSchema>;
