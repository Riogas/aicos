import type Redis from "ioredis";
import type { AggregateStats, BestForResult, OutcomeInput } from "./types.js";

/**
 * Storage model:
 *   - Per (taskType, provider, cli, model) tuple, we keep a hash with
 *     accumulated counters:
 *       key = learning:agg:{taskType}:{provider}:{cli}:{model}
 *       fields: total, success, totalDurationMs, totalCostUsd, lastRunAt
 *   - Sorted set per taskType for fast ranking:
 *       key = learning:rank:{taskType}
 *       member = {provider}|{cli}|{model}
 *       score = best-for score (recomputed on each record)
 *   - Recent outcomes list (audit):
 *       key = learning:audit:{date YYYY-MM-DD}
 *       TTL 30 days
 */

const RANK_KEY = (taskType: string) => `learning:rank:${taskType}`;
const AGG_KEY = (taskType: string, provider: string, cli: string, model: string) =>
  `learning:agg:${taskType}:${provider}:${cli}:${model}`;
const MEMBER = (provider: string, cli: string, model: string) => `${provider}|${cli}|${model}`;

const EPSILON = 0.0001; // avoid div by zero when avgCost is 0
const MIN_SAMPLES_FOR_RECOMMENDATION = 3;

export interface LearningStore {
  record(input: OutcomeInput): Promise<void>;
  bestFor(taskType: string, minSamples?: number): Promise<BestForResult>;
  recent(limit?: number): Promise<OutcomeInput[]>;
  summary(): Promise<Record<string, BestForResult>>;
}

export class RedisLearningStore implements LearningStore {
  constructor(private readonly redis: Redis) {}

  private computeScore(stats: Omit<AggregateStats, "score">): number {
    // Score = successRate / (avgCost + epsilon)
    // - Strongly rewards high success rate
    // - Penalizes high cost (cheaper providers rank higher when success is similar)
    // - At avgCost=0 (Claude Max session, no per-msg cost), score = successRate / epsilon → very high
    //   (this is intentional: subscription CLIs are "free" at the margin so they rank top when they work)
    return stats.successRate / (stats.avgCostUsd + EPSILON);
  }

  async record(input: OutcomeInput): Promise<void> {
    const aggKey = AGG_KEY(input.taskType, input.provider, input.cli, input.model);
    const now = new Date().toISOString();

    const pipeline = this.redis.multi();
    pipeline.hincrby(aggKey, "total", 1);
    if (input.success) pipeline.hincrby(aggKey, "success", 1);
    pipeline.hincrby(aggKey, "totalDurationMs", input.durationMs);
    pipeline.hincrbyfloat(aggKey, "totalCostUsd", input.costUsd);
    pipeline.hset(aggKey, "lastRunAt", now);
    await pipeline.exec();

    // Re-read for ranking
    const agg = await this.redis.hgetall(aggKey);
    const total = parseInt(agg["total"] ?? "0", 10);
    const success = parseInt(agg["success"] ?? "0", 10);
    const totalDur = parseInt(agg["totalDurationMs"] ?? "0", 10);
    const totalCost = parseFloat(agg["totalCostUsd"] ?? "0");
    const stats: AggregateStats = {
      provider: input.provider,
      cli: input.cli,
      model: input.model,
      total,
      success,
      successRate: total > 0 ? success / total : 0,
      avgDurationMs: total > 0 ? totalDur / total : 0,
      avgCostUsd: total > 0 ? totalCost / total : 0,
      score: 0,
      lastRunAt: now,
    };
    stats.score = this.computeScore(stats);

    await this.redis.zadd(
      RANK_KEY(input.taskType),
      stats.score,
      MEMBER(input.provider, input.cli, input.model),
    );

    // Audit log
    const dateKey = `learning:audit:${now.slice(0, 10)}`;
    this.redis
      .rpush(dateKey, JSON.stringify({ ...input, ts: now }))
      .then(() => this.redis.expire(dateKey, 30 * 24 * 3600, "NX"))
      .catch((e) => process.stderr.write(`[learning] audit fail: ${(e as Error).message}\n`));
  }

  async bestFor(
    taskType: string,
    minSamples: number = MIN_SAMPLES_FOR_RECOMMENDATION,
  ): Promise<BestForResult> {
    const members = await this.redis.zrevrange(RANK_KEY(taskType), 0, 9, "WITHSCORES");
    const candidates: AggregateStats[] = [];
    let totalSamples = 0;
    for (let i = 0; i < members.length; i += 2) {
      const member = members[i]!;
      const score = parseFloat(members[i + 1]!);
      const [provider, cli, model] = member.split("|");
      if (!provider || !cli || !model) continue;
      const agg = await this.redis.hgetall(AGG_KEY(taskType, provider, cli, model));
      const total = parseInt(agg["total"] ?? "0", 10);
      const success = parseInt(agg["success"] ?? "0", 10);
      const totalDur = parseInt(agg["totalDurationMs"] ?? "0", 10);
      const totalCost = parseFloat(agg["totalCostUsd"] ?? "0");
      totalSamples += total;
      candidates.push({
        provider,
        cli,
        model,
        total,
        success,
        successRate: total > 0 ? success / total : 0,
        avgDurationMs: total > 0 ? totalDur / total : 0,
        avgCostUsd: total > 0 ? totalCost / total : 0,
        score,
        lastRunAt: agg["lastRunAt"],
      });
    }
    const eligibleBest = candidates.find((c) => c.total >= minSamples);
    return {
      taskType,
      candidates,
      best: eligibleBest,
      totalSamples,
      source: eligibleBest ? "data" : "default",
    };
  }

  async recent(limit: number = 50): Promise<OutcomeInput[]> {
    const todayKey = `learning:audit:${new Date().toISOString().slice(0, 10)}`;
    const raw = await this.redis.lrange(todayKey, -limit, -1);
    return raw
      .map((s) => {
        try {
          return JSON.parse(s) as OutcomeInput;
        } catch {
          return null;
        }
      })
      .filter((x): x is OutcomeInput => x !== null)
      .reverse();
  }

  async summary(): Promise<Record<string, BestForResult>> {
    const taskTypes = ["trivial", "bug-fix", "small-feature", "critical", "large-context", "other"];
    const out: Record<string, BestForResult> = {};
    for (const t of taskTypes) {
      out[t] = await this.bestFor(t);
    }
    return out;
  }
}
