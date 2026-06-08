/**
 * HTTP client minimal al @aicos/learning service (R8).
 *
 * Opt-in via env LEARNING_SERVICE_URL. Fire-and-forget — el run del agente
 * NUNCA bloquea esperando el outcome record.
 */

export interface LearningOutcome {
  provider: string;
  cli: string;
  model: string;
  taskType?: "trivial" | "bug-fix" | "small-feature" | "critical" | "large-context" | "other";
  success: boolean;
  durationMs: number;
  costUsd: number;
  agentRegistryId?: string;
  ticketId?: string;
  failureReason?: string;
}

export interface LearningClient {
  recordOutcome(outcome: LearningOutcome): Promise<boolean>;
  isEnabled(): boolean;
}

const TIMEOUT_MS = 3000;

export function createLearningClient(url: string | undefined): LearningClient {
  if (!url) {
    return {
      isEnabled: () => false,
      recordOutcome: async () => false,
    };
  }
  const base = url.replace(/\/$/, "");
  return {
    isEnabled: () => true,
    async recordOutcome(outcome) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}/outcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(outcome),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) {
          process.stderr.write(`[learning] /outcome ${res.status}\n`);
          return false;
        }
        return true;
      } catch (e) {
        process.stderr.write(`[learning] /outcome fail: ${(e as Error).message}\n`);
        return false;
      }
    },
  };
}
