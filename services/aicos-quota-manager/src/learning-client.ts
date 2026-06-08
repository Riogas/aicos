/**
 * HTTP client del Quota Manager hacia el Learning service (L7).
 *
 * Opt-in via LEARNING_SERVICE_URL. Si responde con ranking valido,
 * `selectModelCore` lo usa para re-ordenar candidatos por score historico
 * antes de aplicar disponibilidad. Fail-open: si learning esta caido,
 * volvemos al orden preferred/fallback que viene en el query.
 */

export interface RankedCandidate {
  provider: string;
  cli: string;
  model: string;
  score: number;
  total: number;
}

export interface BestForResult {
  taskType: string;
  candidates: RankedCandidate[];
  best?: RankedCandidate;
  totalSamples: number;
  source: "data" | "default";
}

export interface LearningClient {
  bestFor(taskType: string): Promise<BestForResult | null>;
  isEnabled(): boolean;
}

const TIMEOUT_MS = 1500;

export function createLearningClient(url: string | undefined): LearningClient {
  if (!url) {
    return {
      isEnabled: () => false,
      bestFor: async () => null,
    };
  }
  const base = url.replace(/\/$/, "");
  return {
    isEnabled: () => true,
    async bestFor(taskType) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}/best-for?taskType=${encodeURIComponent(taskType)}`, {
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) return null;
        return (await res.json()) as BestForResult;
      } catch {
        return null;
      }
    },
  };
}
