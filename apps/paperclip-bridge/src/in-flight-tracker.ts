/**
 * In-flight run tracker with per-stage visibility.
 *
 * A run goes through these stages in order:
 *   dispatched     - bridge received the issue, no work started yet
 *   memory-retrieve - querying qdrant for relevant memories
 *   quota-select   - asking quota manager which CLI to use
 *   cli-running    - the actual claude/codex/agy/opencode invocation
 *   posting-result - writing comment + status back to Paperclip
 *   done           - completed (success or failure); removed shortly after
 *
 * Two transports feed events into the tracker:
 *   - direct in-process calls from server.ts /run path (HTTP-mode bridge)
 *   - POST /stage from paperclip-process-mode.ts (process-adapter spawned
 *     inside the Paperclip container, talks to bridge via host.docker.internal)
 *
 * Events are emitted via Node EventEmitter for the SSE /events endpoint.
 */

import { EventEmitter } from "node:events";
import type Redis from "ioredis";

export type RunStage =
  | "dispatched"
  | "memory-retrieve"
  | "quota-select"
  | "cli-running"
  | "posting-result"
  | "done";

export const STAGE_ORDER: RunStage[] = [
  "dispatched",
  "memory-retrieve",
  "quota-select",
  "cli-running",
  "posting-result",
  "done",
];

export interface InFlightRun {
  runId: string;
  persona?: string;
  personaName?: string;
  cli?: string;
  model?: string;
  ticketIdentifier?: string;
  startedAt: string;
  stage: RunStage;
  stageHistory: Array<{ stage: RunStage; at: string }>;
}

export interface TrackerEvent {
  type: "start" | "stage" | "update" | "end";
  runId: string;
  at: string;
  run: InFlightRun;
}

/** Keep done runs visible briefly so SSE clients see the transition before removal. */
const DONE_TTL_MS = 5_000;
/** Redis key prefix + TTL for persisted runs. Long enough to survive a bridge crash. */
const REDIS_KEY_PREFIX = "aicos:tracker:run:";
const REDIS_TTL_S = 3600; // 1h — runs older than this are stale anyway

export interface TrackerOptions {
  /** Optional Redis client. If provided, runs persist across bridge restarts. */
  redis?: Redis;
}

export class InFlightTracker extends EventEmitter {
  private runs = new Map<string, InFlightRun>();
  private timers = new Map<string, NodeJS.Timeout>();
  private redis?: Redis;

  constructor(opts: TrackerOptions = {}) {
    super();
    this.redis = opts.redis;
    if (this.redis) {
      // Restore any runs that were active when we crashed.
      void this.restoreFromRedis();
    }
  }

  private redisKey(runId: string): string {
    return `${REDIS_KEY_PREFIX}${runId}`;
  }

  private async persist(run: InFlightRun): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(this.redisKey(run.runId), JSON.stringify(run), "EX", REDIS_TTL_S);
    } catch {
      // best-effort
    }
  }

  private async forget(runId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(this.redisKey(runId));
    } catch {
      // best-effort
    }
  }

  /**
   * Restore runs that were active when the bridge was killed. Each restored
   * run gets a "stage" event so SSE clients reconnecting after the crash see
   * an accurate snapshot.
   */
  private async restoreFromRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      const keys = await this.redis.keys(`${REDIS_KEY_PREFIX}*`);
      let restored = 0;
      for (const key of keys) {
        const value = await this.redis.get(key);
        if (!value) continue;
        try {
          const run = JSON.parse(value) as InFlightRun;
          if (!run.runId) continue;
          this.runs.set(run.runId, run);
          restored++;
          this.emit("event", {
            type: "start",
            runId: run.runId,
            at: new Date().toISOString(),
            run,
          });
        } catch {
          // skip malformed entries
        }
      }
      if (restored > 0) {
        process.stderr.write(`[tracker] restored ${restored} runs from Redis\n`);
      }
    } catch (e) {
      process.stderr.write(`[tracker] restore-from-redis failed: ${(e as Error).message}\n`);
    }
  }

  start(init: {
    runId: string;
    persona?: string;
    personaName?: string;
    ticketIdentifier?: string;
    cli?: string;
    model?: string;
  }): void {
    const at = new Date().toISOString();
    const run: InFlightRun = {
      ...init,
      startedAt: at,
      stage: "dispatched",
      stageHistory: [{ stage: "dispatched", at }],
    };
    this.runs.set(run.runId, run);
    void this.persist(run);
    this.emit("event", { type: "start", runId: run.runId, at, run });
  }

  setStage(runId: string, stage: RunStage, extra?: Partial<InFlightRun>): void {
    const existing = this.runs.get(runId);
    const at = new Date().toISOString();
    if (!existing) {
      // Late-arriving event: synthesize a run on the fly so SSE consumers
      // don't lose information.
      const synthetic: InFlightRun = {
        runId,
        startedAt: at,
        stage,
        stageHistory: [{ stage, at }],
        ...extra,
      };
      this.runs.set(runId, synthetic);
      this.emit("event", { type: "start", runId, at, run: synthetic });
      return;
    }
    if (existing.stage === stage && !extra) return; // dedup no-ops
    existing.stage = stage;
    existing.stageHistory.push({ stage, at });
    if (extra) Object.assign(existing, extra);
    void this.persist(existing);
    this.emit("event", { type: "stage", runId, at, run: existing });

    if (stage === "done") {
      // Drop after DONE_TTL_MS so brief consumers can still see the final state.
      const t = setTimeout(() => {
        this.runs.delete(runId);
        this.timers.delete(runId);
        void this.forget(runId);
        this.emit("event", { type: "end", runId, at: new Date().toISOString(), run: existing });
      }, DONE_TTL_MS);
      this.timers.set(runId, t);
    }
  }

  update(runId: string, patch: Partial<InFlightRun>): void {
    const existing = this.runs.get(runId);
    if (!existing) return;
    Object.assign(existing, patch);
    void this.persist(existing);
    this.emit("event", {
      type: "update",
      runId,
      at: new Date().toISOString(),
      run: existing,
    });
  }

  list(): InFlightRun[] {
    return Array.from(this.runs.values());
  }

  get(runId: string): InFlightRun | undefined {
    return this.runs.get(runId);
  }

  /** Clear out everything immediately. Used at server shutdown. */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.runs.clear();
  }
}
