import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  candidateSchema,
  selectQuerySchema,
  usageInputSchema,
  type QuotaManager,
} from "./types.js";
import { NoCandidateAvailableError } from "./quota-memory.js";

export interface ServerOpts {
  port: number;
  manager: QuotaManager;
  quotaEnabled: boolean;
}

export async function startServer(opts: ServerOpts): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-quota-manager",
    quotaEnabled: opts.quotaEnabled,
  }));

  app.get("/status", async () => {
    return await opts.manager.snapshot();
  });

  app.post("/usage", async (req, reply) => {
    const parsed = usageInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    await opts.manager.recordUsage(parsed.data);
    const snap = await opts.manager.snapshot();
    const prov = snap.providers[parsed.data.provider];
    return {
      ok: true,
      recorded: parsed.data,
      windowResetAt: prov?.windowResetAt,
      providerState: prov,
    };
  });

  const selectBodySchema = z.object({
    role: z.string().optional(),
    task: selectQuerySchema.shape.task,
    candidates: z.array(candidateSchema).min(1),
  });

  app.post("/select", async (req, reply) => {
    const parsed = selectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    if (!opts.quotaEnabled) {
      const first = parsed.data.candidates[0]!;
      return {
        chosen: first,
        reason: "first-when-disabled",
        survivalActive: false,
        skipped: [],
      };
    }
    try {
      const result = await opts.manager.selectModel(parsed.data);
      return result;
    } catch (e) {
      if (e instanceof NoCandidateAvailableError) {
        reply.code(503);
        return {
          error: "no-candidate-available",
          survivalActive: e.survivalActive,
          skipped: e.skipped,
        };
      }
      throw e;
    }
  });

  const downBodySchema = z.object({
    cooldownSec: z.number().int().positive(),
    reason: z.string().optional(),
  });

  app.post<{ Params: { name: string } }>("/providers/:name/down", async (req, reply) => {
    const parsed = downBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    await opts.manager.markProviderDown(
      req.params.name,
      parsed.data.cooldownSec,
      parsed.data.reason,
    );
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>("/providers/:name/down", async (req) => {
    await opts.manager.clearProviderDown(req.params.name);
    return { ok: true };
  });

  await app.listen({ host: "0.0.0.0", port: opts.port });
  return app;
}
