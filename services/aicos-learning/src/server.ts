import Fastify, { type FastifyInstance } from "fastify";
import { outcomeInputSchema } from "./types.js";
import type { LearningStore } from "./store.js";
import { z } from "zod";

export interface ServerOpts {
  port: number;
  store: LearningStore;
  learningEnabled: boolean;
}

export async function startServer(opts: ServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-learning",
    learningEnabled: opts.learningEnabled,
  }));

  app.post("/outcome", async (req, reply) => {
    const parsed = outcomeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    if (!opts.learningEnabled) return { ok: true, recorded: false, note: "disabled" };
    await opts.store.record(parsed.data);
    return { ok: true, recorded: true };
  });

  const bestForQuery = z.object({
    taskType: z.string().min(1),
    minSamples: z.coerce.number().int().nonnegative().optional(),
  });

  app.get("/best-for", async (req, reply) => {
    const parsed = bestForQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    return await opts.store.bestFor(parsed.data.taskType, parsed.data.minSamples);
  });

  app.get("/recent", async () => ({
    items: await opts.store.recent(50),
  }));

  app.get("/summary", async () => opts.store.summary());

  await app.listen({ host: "0.0.0.0", port: opts.port });
  return app;
}
