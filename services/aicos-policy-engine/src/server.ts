import Fastify, { type FastifyInstance } from "fastify";
import type { Ruleset } from "./types.js";
import { evaluateInputSchema } from "./types.js";
import { evaluate } from "./rules.js";

export interface ServerOpts {
  port: number;
  ruleset: Ruleset;
  policyEnabled: boolean;
}

export async function startServer(opts: ServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-policy-engine",
    policyEnabled: opts.policyEnabled,
    ruleCount: opts.ruleset.rules.length,
  }));

  app.get("/rules", async () => opts.ruleset);

  app.post("/evaluate", async (req, reply) => {
    const parsed = evaluateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    if (!opts.policyEnabled) {
      return {
        decision: "allow",
        reason: "policy engine disabled (POLICY_ENABLED=false)",
        evaluated: parsed.data,
      };
    }
    return evaluate(parsed.data, opts.ruleset);
  });

  await app.listen({ host: "0.0.0.0", port: opts.port });
  return app;
}
