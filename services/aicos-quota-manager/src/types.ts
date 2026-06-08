import { z } from "zod";

export const candidateSchema = z.object({
  cli: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
});

export type Candidate = z.infer<typeof candidateSchema>;

export const providerBudgetSchema = z.object({
  windowSec: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative().optional(),
  maxRequests: z.number().int().positive().optional(),
});

export type ProviderBudget = z.infer<typeof providerBudgetSchema>;

export const cliBudgetSchema = z.object({
  windowSec: z.number().int().positive(),
  maxRequests: z.number().int().positive(),
  session: z.string().optional(),
});

export type CliBudget = z.infer<typeof cliBudgetSchema>;

export const budgetsSchema = z.object({
  criticalProvider: z.string().min(1).default("anthropic"),
  survivalModels: z.array(candidateSchema).default([]),
  providers: z.record(z.string(), providerBudgetSchema).default({}),
  clis: z.record(z.string(), cliBudgetSchema).default({}),
});

export type Budgets = z.infer<typeof budgetsSchema>;

export const usageInputSchema = z.object({
  provider: z.string().min(1),
  cli: z.string().optional(),
  costUsd: z.number().nonnegative(),
  requests: z.number().int().positive().optional().default(1),
  tokens: z
    .object({
      input: z.number().int().nonnegative().optional(),
      output: z.number().int().nonnegative().optional(),
      cached: z.number().int().nonnegative().optional(),
    })
    .optional(),
  model: z.string().optional(),
  agentRegistryId: z.string().optional(),
  ticketId: z.string().optional(),
});

export type UsageInput = z.infer<typeof usageInputSchema>;

export const selectQuerySchema = z.object({
  role: z.string().optional(),
  task: z.enum(["trivial", "bug-fix", "small-feature", "critical", "large-context"]).optional(),
  candidates: z.array(candidateSchema).min(1),
});

export type SelectQuery = z.infer<typeof selectQuerySchema>;

export interface SelectResult {
  chosen: Candidate;
  reason: "preferred" | "fallback" | "survival" | "smart" | "first-when-disabled";
  survivalActive: boolean;
  skipped: Array<{ candidate: Candidate; reason: string }>;
  smartRoutingActive?: boolean;
}

export interface ProviderState {
  windowSec: number;
  usedCostUsd: number;
  requests: number;
  budget?: ProviderBudget;
  available: boolean;
  unavailableReason?: string;
  windowResetAt?: string;
}

export interface CliState {
  windowSec: number;
  requests: number;
  budget?: CliBudget;
  available: boolean;
  unavailableReason?: string;
  windowResetAt?: string;
}

export interface Snapshot {
  criticalProvider: string;
  survivalActive: boolean;
  survivalModels: Candidate[];
  providers: Record<string, ProviderState>;
  clis: Record<string, CliState>;
  generatedAt: string;
}

export interface Availability {
  available: boolean;
  reason?: string;
}

export interface QuotaManager {
  recordUsage(input: UsageInput): Promise<void>;
  isProviderAvailable(provider: string): Promise<Availability>;
  isCliAvailable(cli: string): Promise<Availability>;
  markProviderDown(provider: string, cooldownSec: number, reason?: string): Promise<void>;
  clearProviderDown(provider: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  survivalActive(): Promise<boolean>;
  selectModel(query: SelectQuery): Promise<SelectResult>;
}
