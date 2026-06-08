import type Redis from "ioredis";
import type {
  Availability,
  Budgets,
  CliState,
  ProviderState,
  QuotaManager,
  SelectQuery,
  SelectResult,
  Snapshot,
  UsageInput,
} from "./types.js";
import { selectModelCore } from "./quota-memory.js";
import type { LearningClient } from "./learning-client.js";

/**
 * Redis-backed QuotaManager. Safe across multiple worker processes.
 *
 * Key shapes:
 *   quota:provider:{name}:cost   string (float), TTL=windowSec
 *   quota:provider:{name}:reqs   string (int),   TTL=windowSec
 *   quota:provider:{name}:down   string (reason), TTL=cooldownSec
 *   quota:cli:{name}:reqs        string (int),   TTL=windowSec
 *
 * Window semantics: fixed window via Redis TTL — the first INCR sets the TTL,
 * subsequent INCRs reuse it until expiry (Redis preserves TTL on INCR).
 * This is a "tumbling" window and is sufficient for budget enforcement.
 */
export class RedisQuotaManager implements QuotaManager {
  // Expose budgets so selectModelCore can read survivalModels.
  public readonly budgets: Budgets;
  public learningClient?: LearningClient;
  constructor(private readonly redis: Redis, budgets: Budgets, learningClient?: LearningClient) {
    this.budgets = budgets;
    this.learningClient = learningClient;
  }

  private providerCostKey(provider: string): string {
    return `quota:provider:${provider}:cost`;
  }
  private providerReqsKey(provider: string): string {
    return `quota:provider:${provider}:reqs`;
  }
  private providerDownKey(provider: string): string {
    return `quota:provider:${provider}:down`;
  }
  private cliReqsKey(cli: string): string {
    return `quota:cli:${cli}:reqs`;
  }

  async recordUsage(input: UsageInput): Promise<void> {
    const pb = this.budgets.providers[input.provider];
    const windowSec = pb?.windowSec ?? 3600;
    const requests = input.requests ?? 1;

    const costKey = this.providerCostKey(input.provider);
    const reqsKey = this.providerReqsKey(input.provider);

    // INCRBYFLOAT + INCR atomic via pipeline; TTL set on first write via SET NX (race-safe).
    const pipeline = this.redis.multi();
    if (input.costUsd > 0) {
      pipeline.incrbyfloat(costKey, input.costUsd);
      pipeline.expire(costKey, windowSec, "NX");
    }
    pipeline.incrby(reqsKey, requests);
    pipeline.expire(reqsKey, windowSec, "NX");

    if (input.cli) {
      const cb = this.budgets.clis[input.cli];
      const cliWindowSec = cb?.windowSec ?? 3600;
      const cliReqsKey = this.cliReqsKey(input.cli);
      pipeline.incrby(cliReqsKey, requests);
      pipeline.expire(cliReqsKey, cliWindowSec, "NX");
    }
    await pipeline.exec();

    // Optional audit log (best-effort, no await)
    const dateKey = `quota:audit:${new Date().toISOString().slice(0, 10)}`;
    this.redis
      .rpush(dateKey, JSON.stringify({ ...input, ts: new Date().toISOString() }))
      .then(() => this.redis.expire(dateKey, 7 * 24 * 3600, "NX"))
      .catch((e) => process.stderr.write(`[quota] audit fail: ${(e as Error).message}\n`));
  }

  async isProviderAvailable(provider: string): Promise<Availability> {
    const downReason = await this.redis.get(this.providerDownKey(provider));
    if (downReason) return { available: false, reason: `down: ${downReason}` };

    const budget = this.budgets.providers[provider];
    if (!budget) return { available: true };

    const [costStr, reqsStr] = await this.redis.mget(
      this.providerCostKey(provider),
      this.providerReqsKey(provider),
    );
    const cost = costStr ? parseFloat(costStr) : 0;
    const reqs = reqsStr ? parseInt(reqsStr, 10) : 0;

    if (budget.maxCostUsd !== undefined && cost >= budget.maxCostUsd) {
      return { available: false, reason: `over-budget: $${cost.toFixed(4)}/$${budget.maxCostUsd}` };
    }
    if (budget.maxRequests !== undefined && reqs >= budget.maxRequests) {
      return { available: false, reason: `over-requests: ${reqs}/${budget.maxRequests}` };
    }
    return { available: true };
  }

  async isCliAvailable(cli: string): Promise<Availability> {
    const budget = this.budgets.clis[cli];
    if (!budget) return { available: true };
    const reqsStr = await this.redis.get(this.cliReqsKey(cli));
    const reqs = reqsStr ? parseInt(reqsStr, 10) : 0;
    if (reqs >= budget.maxRequests) {
      return { available: false, reason: `over-requests: ${reqs}/${budget.maxRequests}` };
    }
    return { available: true };
  }

  async markProviderDown(provider: string, cooldownSec: number, reason = "manual"): Promise<void> {
    await this.redis.set(this.providerDownKey(provider), reason, "EX", cooldownSec);
  }

  async clearProviderDown(provider: string): Promise<void> {
    await this.redis.del(this.providerDownKey(provider));
  }

  async survivalActive(): Promise<boolean> {
    const a = await this.isProviderAvailable(this.budgets.criticalProvider);
    return !a.available;
  }

  async snapshot(): Promise<Snapshot> {
    const providers: Record<string, ProviderState> = {};
    const seenProviders = new Set<string>([...Object.keys(this.budgets.providers)]);
    for (const name of seenProviders) {
      const budget = this.budgets.providers[name];
      const [costStr, reqsStr, ttl] = await Promise.all([
        this.redis.get(this.providerCostKey(name)),
        this.redis.get(this.providerReqsKey(name)),
        this.redis.ttl(this.providerReqsKey(name)),
      ]);
      const cost = costStr ? parseFloat(costStr) : 0;
      const reqs = reqsStr ? parseInt(reqsStr, 10) : 0;
      const av = await this.isProviderAvailable(name);
      providers[name] = {
        windowSec: budget?.windowSec ?? 3600,
        usedCostUsd: cost,
        requests: reqs,
        budget,
        available: av.available,
        unavailableReason: av.reason,
        windowResetAt:
          ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : undefined,
      };
    }

    const clis: Record<string, CliState> = {};
    const seenClis = new Set<string>([...Object.keys(this.budgets.clis)]);
    for (const name of seenClis) {
      const budget = this.budgets.clis[name];
      const [reqsStr, ttl] = await Promise.all([
        this.redis.get(this.cliReqsKey(name)),
        this.redis.ttl(this.cliReqsKey(name)),
      ]);
      const reqs = reqsStr ? parseInt(reqsStr, 10) : 0;
      const av = await this.isCliAvailable(name);
      clis[name] = {
        windowSec: budget?.windowSec ?? 3600,
        requests: reqs,
        budget,
        available: av.available,
        unavailableReason: av.reason,
        windowResetAt:
          ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : undefined,
      };
    }

    return {
      criticalProvider: this.budgets.criticalProvider,
      survivalActive: await this.survivalActive(),
      survivalModels: this.budgets.survivalModels,
      providers,
      clis,
      generatedAt: new Date().toISOString(),
    };
  }

  async selectModel(query: SelectQuery): Promise<SelectResult> {
    return selectModelCore(query, this, this.learningClient);
  }
}
