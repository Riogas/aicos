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

/** One streamed chunk of agent output (live uplink). */
export interface OutputChunk {
  seq: number;
  kind: "text" | "tool" | "thinking";
  text: string;
  at: string;
}

export interface InFlightRun {
  runId: string;
  persona?: string;
  personaName?: string;
  cli?: string;
  model?: string;
  ticketIdentifier?: string;
  startedAt: string;
  /** Last time ANY event touched this run — used by the stale-run reaper. */
  lastActivityAt: string;
  stage: RunStage;
  stageHistory: Array<{ stage: RunStage; at: string }>;
  /** Ring buffer of recent output chunks (for snapshot replay to fresh clients). */
  outputBuffer?: OutputChunk[];
  /** Monotonic output counter. */
  outputSeq?: number;
}

export interface TrackerEvent {
  type: "start" | "stage" | "update" | "end" | "output";
  runId: string;
  at: string;
  run: InFlightRun;
  /** Present only for type==="output". */
  output?: OutputChunk;
}

/** How many recent output chunks to keep per run for snapshot replay. */
const OUTPUT_BUFFER_MAX = 60;

/** Keep done runs visible briefly so SSE clients see the transition before removal. */
const DONE_TTL_MS = 5_000;
/**
 * Runs that haven't had ANY event in this long are reaped — they're zombies
 * from a killed/crashed process that never sent a "done". Without this they
 * linger forever and make the dashboard look like phantom parallel runs.
 */
const STALE_RUN_MS = 10 * 60 * 1000;
const REAP_INTERVAL_MS = 60_000;
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

  private reaper?: NodeJS.Timeout;

  constructor(opts: TrackerOptions = {}) {
    super();
    this.redis = opts.redis;
    if (this.redis) {
      // Restore any runs that were active when we crashed.
      void this.restoreFromRedis();
    }
    // Reap zombie runs (killed processes that never sent "done").
    this.reaper = setInterval(() => this.reapStale(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  /** Drop runs with no activity for STALE_RUN_MS that never reached "done". */
  private reapStale(): void {
    const now = Date.now();
    for (const [runId, run] of this.runs) {
      if (run.stage === "done") continue;
      const last = Date.parse(run.lastActivityAt || run.startedAt);
      if (Number.isFinite(last) && now - last > STALE_RUN_MS) {
        this.runs.delete(runId);
        const t = this.timers.get(runId);
        if (t) {
          clearTimeout(t);
          this.timers.delete(runId);
        }
        void this.forget(runId);
        this.emit("event", { type: "end", runId, at: new Date().toISOString(), run });
        process.stderr.write(`[tracker] reaped stale run ${runId} (${run.ticketIdentifier ?? "?"})\n`);
      }
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
      lastActivityAt: at,
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
        lastActivityAt: at,
        stage,
        stageHistory: [{ stage, at }],
        ...extra,
      };
      this.runs.set(runId, synthetic);
      this.emit("event", { type: "start", runId, at, run: synthetic });
      return;
    }
    existing.lastActivityAt = at;
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

  /**
   * Append a live output chunk and broadcast it. Lightweight: NOT persisted to
   * Redis (too chatty) — only kept in-memory in a small ring buffer for replay.
   * Synthesizes a run if the chunk arrives before any stage event.
   */
  appendOutput(
    runId: string,
    chunk: { kind: OutputChunk["kind"]; text: string },
    meta?: { persona?: string; personaName?: string; ticketIdentifier?: string },
  ): void {
    let run = this.runs.get(runId);
    const at = new Date().toISOString();
    if (!run) {
      run = {
        runId,
        startedAt: at,
        lastActivityAt: at,
        stage: "cli-running",
        stageHistory: [{ stage: "cli-running", at }],
        ...meta,
      };
      this.runs.set(runId, run);
      this.emit("event", { type: "start", runId, at, run });
    }
    run.lastActivityAt = at;
    run.outputSeq = (run.outputSeq ?? 0) + 1;
    const oc: OutputChunk = {
      seq: run.outputSeq,
      kind: chunk.kind,
      // cap per-chunk size so a giant tool result can't flood the SSE pipe
      text: chunk.text.length > 4000 ? chunk.text.slice(0, 4000) + "…" : chunk.text,
      at,
    };
    run.outputBuffer = run.outputBuffer ?? [];
    run.outputBuffer.push(oc);
    if (run.outputBuffer.length > OUTPUT_BUFFER_MAX) run.outputBuffer.shift();
    this.emit("event", { type: "output", runId, at, run, output: oc });
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
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }
}
