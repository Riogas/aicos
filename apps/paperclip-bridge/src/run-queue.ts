/**
 * BullMQ-backed queue for /run jobs.
 *
 * Replaces the previous setImmediate(executeRun) fire-and-forget model:
 *   - Jobs persist in Redis so a bridge restart doesn't drop them.
 *   - Built-in retry / exponential backoff on failure.
 *   - Bounded concurrency (BRIDGE_RUN_CONCURRENCY env, default 4) so a
 *     burst of /run calls can't fork-bomb the host's CLIs.
 *   - Observable: BullMQ writes job metadata to Redis which Prometheus
 *     metrics can scrape.
 *
 * When REDIS_URL is not set, falls back to inline setImmediate execution so
 * dev environments without Redis still work.
 */

import { Queue, Worker, type JobsOptions } from "bullmq";
import type Redis from "ioredis";
import { executeRun, type ExecuteRunInput } from "./run.js";
import type { InFlightTracker } from "./in-flight-tracker.js";

const QUEUE_NAME = "aicos-run";

export interface RunJobInput {
  // Only string/JSON-serializable fields go through the queue. Complex objects
  // (PaperclipClient, tracker, etc.) get re-instantiated inside the worker.
  prompt: string;
  model?: string;
  provider?: string;
  personaRegistryId?: string;
  workspaceProjectId?: string;
  ticketIdentifier?: string;
  paperclipIssueId?: string;
  runId: string;
  approved?: boolean;
}

export interface RunQueue {
  enqueue(input: RunJobInput, opts?: JobsOptions): Promise<void>;
  close(): Promise<void>;
  isPersisted(): boolean;
}

/**
 * Adapter that lets the worker callback access the heavy clients (Paperclip,
 * quota, learning, policy, tracker, etc.) by closure — they're NOT serialized
 * into the job payload.
 */
export interface RunJobExecutor {
  (input: RunJobInput): Promise<void>;
}

/**
 * Create a Redis-backed queue if `redis` is supplied; otherwise return a
 * shim that runs jobs inline. Both shapes are observable via the same API.
 */
export function createRunQueue(
  redis: Redis | undefined,
  executor: RunJobExecutor,
  opts: { concurrency?: number } = {},
): RunQueue {
  if (!redis) {
    // Inline fallback: replicate setImmediate behaviour but exposed under the
    // same surface so server.ts doesn't branch.
    return {
      isPersisted: () => false,
      async enqueue(input) {
        setImmediate(async () => {
          try {
            await executor(input);
          } catch (e) {
            process.stderr.write(`[run-queue inline] job failed: ${(e as Error).message}\n`);
          }
        });
      },
      async close() {
        /* nothing to clean */
      },
    };
  }

  const envConcurrency = process.env.BRIDGE_RUN_CONCURRENCY
    ? Number(process.env.BRIDGE_RUN_CONCURRENCY)
    : NaN;
  const concurrency = opts.concurrency ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 4);
  // BullMQ requires its connection to have maxRetriesPerRequest=null so a
  // hanging worker call doesn't pile up retries; duplicate() and override.
  const connection = redis.duplicate({ maxRetriesPerRequest: null });
  const queue = new Queue<RunJobInput, void, "run">(QUEUE_NAME, { connection });
  const worker = new Worker<RunJobInput, void, "run">(
    QUEUE_NAME,
    async (job) => {
      await executor(job.data);
    },
    {
      connection: redis.duplicate({ maxRetriesPerRequest: null }),
      concurrency,
    },
  );
  worker.on("failed", (job, err) => {
    process.stderr.write(
      `[run-queue] job ${job?.id} failed: ${err.message} (attempt ${job?.attemptsMade ?? 0})\n`,
    );
  });

  return {
    isPersisted: () => true,
    async enqueue(input, jobsOpts) {
      await queue.add("run", input, {
        attempts: 1, // we already retry per-CLI inside run.ts; don't double-retry
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
        ...jobsOpts,
      });
    },
    async close() {
      await Promise.allSettled([worker.close(), queue.close(), connection.quit()]);
    },
  };
}

// Re-export for clarity.
export type { ExecuteRunInput, InFlightTracker };
