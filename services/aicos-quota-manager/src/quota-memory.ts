import type {
  Availability,
  Budgets,
  Candidate,
  ProviderState,
  CliState,
  QuotaManager,
  SelectQuery,
  SelectResult,
  Snapshot,
  UsageInput,
} from "./types.js";

interface WindowCounter {
  cost: number;
  reqs: number;
  windowStartMs: number;
  windowSec: number;
}

interface DownMarker {
  reason: string;
  untilMs: number;
}

/**
 * Pure in-memory QuotaManager. Used for tests and as a fallback when Redis
 * is not configured. NOT process-safe across multiple workers — use
 * RedisQuotaManager in production.
 */
export class InMemoryQuotaManager implements QuotaManager {
  private providers = new Map<string, WindowCounter>();
  private clis = new Map<string, WindowCounter>();
  private down = new Map<string, DownMarker>();
  constructor(
    private readonly budgets: Budgets,
    private readonly now: () => number = Date.now,
  ) {}

  private getOrInit(map: Map<string, WindowCounter>, name: string, windowSec: number): WindowCounter {
    const t = this.now();
    const existing = map.get(name);
    if (existing && t < existing.windowStartMs + existing.windowSec * 1000) {
      return existing;
    }
    const fresh: WindowCounter = { cost: 0, reqs: 0, windowStartMs: t, windowSec };
    map.set(name, fresh);
    return fresh;
  }

  private isWindowExpired(counter: WindowCounter): boolean {
    return this.now() >= counter.windowStartMs + counter.windowSec * 1000;
  }

  async recordUsage(input: UsageInput): Promise<void> {
    const pb = this.budgets.providers[input.provider];
    const windowSec = pb?.windowSec ?? 3600;
    const counter = this.getOrInit(this.providers, input.provider, windowSec);
    counter.cost += input.costUsd;
    counter.reqs += input.requests ?? 1;

    if (input.cli) {
      const cb = this.budgets.clis[input.cli];
      const cliWindowSec = cb?.windowSec ?? 3600;
      const cliCounter = this.getOrInit(this.clis, input.cli, cliWindowSec);
      cliCounter.reqs += input.requests ?? 1;
    }
  }

  async isProviderAvailable(provider: string): Promise<Availability> {
    const downMark = this.down.get(provider);
    if (downMark && this.now() < downMark.untilMs) {
      return { available: false, reason: `down: ${downMark.reason}` };
    }
    const budget = this.budgets.providers[provider];
    if (!budget) return { available: true };
    const counter = this.providers.get(provider);
    if (!counter || this.isWindowExpired(counter)) return { available: true };
    if (budget.maxCostUsd !== undefined && counter.cost >= budget.maxCostUsd) {
      return { available: false, reason: `over-budget: $${counter.cost.toFixed(4)}/$${budget.maxCostUsd}` };
    }
    if (budget.maxRequests !== undefined && counter.reqs >= budget.maxRequests) {
      return { available: false, reason: `over-requests: ${counter.reqs}/${budget.maxRequests}` };
    }
    return { available: true };
  }

  async isCliAvailable(cli: string): Promise<Availability> {
    const budget = this.budgets.clis[cli];
    if (!budget) return { available: true };
    const counter = this.clis.get(cli);
    if (!counter || this.isWindowExpired(counter)) return { available: true };
    if (counter.reqs >= budget.maxRequests) {
      return { available: false, reason: `over-requests: ${counter.reqs}/${budget.maxRequests}` };
    }
    return { available: true };
  }

  async markProviderDown(provider: string, cooldownSec: number, reason = "manual"): Promise<void> {
    this.down.set(provider, { reason, untilMs: this.now() + cooldownSec * 1000 });
  }

  async clearProviderDown(provider: string): Promise<void> {
    this.down.delete(provider);
  }

  async survivalActive(): Promise<boolean> {
    const a = await this.isProviderAvailable(this.budgets.criticalProvider);
    return !a.available;
  }

  async snapshot(): Promise<Snapshot> {
    const providers: Record<string, ProviderState> = {};
    const seenProviders = new Set<string>([
      ...Object.keys(this.budgets.providers),
      ...this.providers.keys(),
    ]);
    for (const name of seenProviders) {
      const budget = this.budgets.providers[name];
      const counter = this.providers.get(name);
      const av = await this.isProviderAvailable(name);
      providers[name] = {
        windowSec: budget?.windowSec ?? 3600,
        usedCostUsd: counter && !this.isWindowExpired(counter) ? counter.cost : 0,
        requests: counter && !this.isWindowExpired(counter) ? counter.reqs : 0,
        budget,
        available: av.available,
        unavailableReason: av.reason,
        windowResetAt:
          counter && !this.isWindowExpired(counter)
            ? new Date(counter.windowStartMs + counter.windowSec * 1000).toISOString()
            : undefined,
      };
    }

    const clis: Record<string, CliState> = {};
    const seenClis = new Set<string>([...Object.keys(this.budgets.clis), ...this.clis.keys()]);
    for (const name of seenClis) {
      const budget = this.budgets.clis[name];
      const counter = this.clis.get(name);
      const av = await this.isCliAvailable(name);
      clis[name] = {
        windowSec: budget?.windowSec ?? 3600,
        requests: counter && !this.isWindowExpired(counter) ? counter.reqs : 0,
        budget,
        available: av.available,
        unavailableReason: av.reason,
        windowResetAt:
          counter && !this.isWindowExpired(counter)
            ? new Date(counter.windowStartMs + counter.windowSec * 1000).toISOString()
            : undefined,
      };
    }

    return {
      criticalProvider: this.budgets.criticalProvider,
      survivalActive: await this.survivalActive(),
      survivalModels: this.budgets.survivalModels,
      providers,
      clis,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  async selectModel(query: SelectQuery): Promise<SelectResult> {
    return selectModelCore(query, this);
  }
}

/**
 * Shared select algorithm: works against ANY QuotaManager. Applies hard rules
 * first, then survival overlay, then preferred/fallback order.
 */
export async function selectModelCore(
  query: SelectQuery,
  mgr: QuotaManager,
): Promise<SelectResult> {
  const skipped: Array<{ candidate: Candidate; reason: string }> = [];
  const survival = await mgr.survivalActive();

  const order = survival
    ? [
        ...(await getSurvivalCandidates(mgr)),
        ...query.candidates,
      ]
    : query.candidates;

  for (const cand of order) {
    const ruleViolation = applyHardRules(cand, query);
    if (ruleViolation) {
      skipped.push({ candidate: cand, reason: ruleViolation });
      continue;
    }
    const provAvail = await mgr.isProviderAvailable(cand.provider);
    if (!provAvail.available) {
      skipped.push({ candidate: cand, reason: `provider ${cand.provider}: ${provAvail.reason}` });
      continue;
    }
    const cliAvail = await mgr.isCliAvailable(cand.cli);
    if (!cliAvail.available) {
      skipped.push({ candidate: cand, reason: `cli ${cand.cli}: ${cliAvail.reason}` });
      continue;
    }
    const reason = survival && order.indexOf(cand) < (await getSurvivalCandidates(mgr)).length
      ? "survival"
      : query.candidates[0]?.provider === cand.provider && query.candidates[0]?.model === cand.model
        ? "preferred"
        : "fallback";
    return {
      chosen: cand,
      reason: reason as SelectResult["reason"],
      survivalActive: survival,
      skipped,
    };
  }

  throw new NoCandidateAvailableError(skipped, survival);
}

export class NoCandidateAvailableError extends Error {
  constructor(
    public readonly skipped: Array<{ candidate: Candidate; reason: string }>,
    public readonly survivalActive: boolean,
  ) {
    super(`No available candidate. ${skipped.length} skipped. survivalActive=${survivalActive}`);
    this.name = "NoCandidateAvailableError";
  }
}

async function getSurvivalCandidates(mgr: QuotaManager): Promise<Candidate[]> {
  if (!(mgr as unknown as { budgets?: Budgets }).budgets) return [];
  return (mgr as unknown as { budgets: Budgets }).budgets.survivalModels;
}

function applyHardRules(cand: Candidate, query: SelectQuery): string | null {
  if (query.task === "trivial" || query.task === "bug-fix") {
    if (/opus/i.test(cand.model)) {
      return `hard-rule: no opus for ${query.task}`;
    }
  }
  if (cand.cli === "antigravity" && query.task && query.task !== "large-context") {
    return `hard-rule: antigravity only for large-context (task=${query.task})`;
  }
  return null;
}
