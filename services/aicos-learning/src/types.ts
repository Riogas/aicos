import { z } from "zod";

export const outcomeInputSchema = z.object({
  /** Which provider was actually used (matches Quota Manager's provider names). */
  provider: z.string().min(1),
  /** Which CLI was actually used (claude / codex / agy / opencode). */
  cli: z.string().min(1),
  /** Which model was actually used. */
  model: z.string().min(1),
  /**
   * Task type classification (matches Quota Manager's task enum):
   * trivial | bug-fix | small-feature | critical | large-context | other
   */
  taskType: z
    .enum(["trivial", "bug-fix", "small-feature", "critical", "large-context", "other"])
    .default("other"),
  /** True when the run completed successfully (exit 0). */
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Optional: which agent role ran (it-architect, etc.). */
  agentRegistryId: z.string().optional(),
  /** Optional: ticket identifier for traceability. */
  ticketId: z.string().optional(),
  /** Optional: short error reason when success=false. */
  failureReason: z.string().optional(),
});
export type OutcomeInput = z.infer<typeof outcomeInputSchema>;

export interface AggregateStats {
  provider: string;
  cli: string;
  model: string;
  total: number;
  success: number;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  /** Score for ranking: success_rate × (1 / (avgCost + epsilon)). Higher is better. */
  score: number;
  lastRunAt?: string;
}

export interface BestForResult {
  taskType: string;
  candidates: AggregateStats[];
  best?: AggregateStats;
  totalSamples: number;
  /** Recommendation source: "data" (>=N runs) or "default" (no data, pass-through). */
  source: "data" | "default";
}
