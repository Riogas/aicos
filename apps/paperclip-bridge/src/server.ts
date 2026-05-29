import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { PaperclipClient } from "./paperclip-client.js";
import { executeRun } from "./run.js";

const RunRequestSchema = z.object({
  issueId: z.string().optional(),
  ticketId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

type RunRequestBody = z.infer<typeof RunRequestSchema>;

export interface ServerOptions {
  port: number;
  paperclipApiUrl?: string;
  paperclipApiKey?: string;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.BRIDGE_LOG_LEVEL ?? "info",
    },
  });

  const paperclipReady =
    Boolean(opts.paperclipApiUrl) && Boolean(opts.paperclipApiKey);

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-bridge",
    version: "0.2.0",
    paperclip: paperclipReady ? "configured" : "missing",
    hermes: "spawned-on-demand",
  }));

  app.post(
    "/run",
    async (req: FastifyRequest, reply: FastifyReply) => {
      let parsed: RunRequestBody;
      try {
        parsed = RunRequestSchema.parse(req.body);
      } catch (e) {
        return reply.code(400).send({
          error: "invalid payload",
          details: (e as Error).message,
        });
      }

      // Contrato real de Paperclip http adapter (descubierto en logs 2026-05-29):
      //   body = { prompt, issueId, agentId, runId, context }
      //   - prompt/issueId top-level: vienen del payloadTemplate del agent
      //     SIN templating (Paperclip los manda literales tipo "{{issue.id}}")
      //   - context.issueId: el UUID REAL del issue
      //   - context.paperclipIssue: objeto issue completo
      //   - context.paperclipTaskMarkdown: contenido del task en MD (ideal como prompt)

      const looksLikeTemplate = (v: string | undefined): boolean =>
        typeof v === "string" && (v.includes("{{") || v.startsWith("${"));

      const ctx = parsed.context as Record<string, unknown> | undefined;
      const ctxIssue = ctx?.paperclipIssue as Record<string, unknown> | undefined;
      const taskMarkdown = ctx?.paperclipTaskMarkdown as string | undefined;

      app.log.info(
        {
          bodyKeys: Object.keys(req.body as object),
          contextIssueId: ctx?.issueId,
          contextTaskId: ctx?.taskId,
          paperclipIssueKeys: ctxIssue ? Object.keys(ctxIssue) : null,
          hasTaskMarkdown: Boolean(taskMarkdown),
          taskMarkdownLen: taskMarkdown?.length ?? 0,
        },
        "payload structure",
      );

      let issueId: string | undefined =
        !looksLikeTemplate(parsed.issueId) ? parsed.issueId : undefined;
      if (!issueId && !looksLikeTemplate(parsed.ticketId))
        issueId = parsed.ticketId;
      if (!issueId && typeof ctx?.issueId === "string") issueId = ctx.issueId;
      if (!issueId && typeof ctxIssue?.id === "string") issueId = ctxIssue.id;

      let prompt: string | undefined =
        !looksLikeTemplate(parsed.prompt) ? parsed.prompt : undefined;

      let pcClient: PaperclipClient | undefined;
      if (issueId && paperclipReady) {
        pcClient = new PaperclipClient(
          {
            apiUrl: opts.paperclipApiUrl!,
            apiKey: opts.paperclipApiKey!,
          },
          parsed.runId,
        );

        // Estrategia de prompt: priorizar el task markdown (ya formateado);
        // fallback a title+description del paperclipIssue; ultimo recurso = GET API.
        if (!prompt && taskMarkdown && taskMarkdown.trim().length > 0) {
          prompt = taskMarkdown.trim();
        }
        if (!prompt && ctxIssue) {
          const title = (ctxIssue.title as string) ?? "";
          const desc =
            (ctxIssue.description as string) ?? (ctxIssue.body as string) ?? "";
          prompt = `${title}\n\n${desc}`.trim();
        }
        if (!prompt) {
          try {
            const issue = await pcClient.getIssue(issueId);
            const title = issue.title ?? "";
            const desc = issue.description ?? issue.body ?? "";
            prompt = `${title}\n\n${desc}`.trim();
          } catch (e) {
            return reply.code(502).send({
              error: "paperclip getIssue failed",
              details: (e as Error).message,
            });
          }
        }
      }

      if (!prompt) {
        return reply.code(400).send({
          error:
            "no prompt provided (payload had only literal templates and no usable context)",
        });
      }

      // Fire-and-forget: NO bloqueamos a Paperclip.
      // El resultado va de vuelta via API (comment + status).
      setImmediate(async () => {
        try {
          const result = await executeRun({
            prompt: prompt!,
            model: parsed.model,
            provider: parsed.provider,
            paperclip:
              pcClient && issueId
                ? { client: pcClient, issueId }
                : undefined,
          });
          app.log.info(
            {
              issueId,
              runId: parsed.runId,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              outputLen: result.output.length,
            },
            "run completed",
          );
        } catch (e) {
          app.log.error(
            { err: (e as Error).message, issueId, runId: parsed.runId },
            "run failed",
          );
        }
      });

      return reply.code(202).send({
        status: "accepted",
        issueId: issueId ?? null,
        runId: parsed.runId ?? null,
      });
    },
  );

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}
