import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { PaperclipClient } from "./paperclip-client.js";
import { executeRun } from "./run.js";
import {
  loadRegistry,
  resolvePersonaByPaperclipId,
  resolveWorkspaceByProjectId,
} from "./registry.js";
import type { ProjectWorkspace } from "./registry.js";
import { createQuotaClient } from "./quota-client.js";
import { createLearningClient } from "./learning-client.js";
import {
  storeMemory,
  retrieveFromScope,
  retrieveAllScopes,
  type MemoryScope,
} from "./memory.js";

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
  quotaServiceUrl?: string;
  learningServiceUrl?: string;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.BRIDGE_LOG_LEVEL ?? "info",
    },
  });

  const registryStats = loadRegistry();
  app.log.info(
    {
      ...registryStats,
    },
    "registry loaded",
  );

  const paperclipReady =
    Boolean(opts.paperclipApiUrl) && Boolean(opts.paperclipApiKey);

  const quotaClient = createQuotaClient(opts.quotaServiceUrl);
  const learningClient = createLearningClient(opts.learningServiceUrl);
  app.log.info(
    {
      quotaEnabled: quotaClient.isEnabled(),
      quotaUrl: opts.quotaServiceUrl ?? null,
      learningEnabled: learningClient.isEnabled(),
      learningUrl: opts.learningServiceUrl ?? null,
    },
    "client init",
  );

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-bridge",
    version: "0.3.0",
    paperclip: paperclipReady ? "configured" : "missing",
    quota: quotaClient.isEnabled() ? "configured" : "missing",
    learning: learningClient.isEnabled() ? "configured" : "missing",
    hermes: "spawned-on-demand",
    registry: {
      loaded: registryStats.registryLoaded && registryStats.keysLoaded,
      resolvableAgents: registryStats.resolvable,
    },
  }));

  app.post("/admin/reload-registry", async () => {
    const s = loadRegistry();
    app.log.info(s, "registry reloaded");
    return { ok: true, ...s };
  });

  // ─── L4 Memory endpoints ─────────────────────────────────────────────────
  const MemoryStoreSchema = z.object({
    scope: z.enum(["agent", "project", "company", "market"]),
    text: z.string().min(1),
    summary: z.string().optional(),
    registryId: z.string().optional(),
    projectId: z.string().optional(),
    ticketId: z.string().optional(),
    ticketIdentifier: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });

  app.post("/memory/store", async (req, reply) => {
    const r = MemoryStoreSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    const ok = await storeMemory(r.data);
    return { ok, scope: r.data.scope };
  });

  const MemorySearchSchema = z.object({
    query: z.string().min(1),
    scope: z.enum(["agent", "project", "company", "market", "all"]).optional(),
    registryId: z.string().optional(),
    projectId: z.string().optional(),
    limit: z.coerce.number().int().positive().max(20).optional(),
  });

  app.post("/memory/search", async (req, reply) => {
    const r = MemorySearchSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    const { query, scope, registryId, projectId, limit } = r.data;
    if (!scope || scope === "all") {
      return {
        items: await retrieveAllScopes(query, { registryId, projectId, perScopeLimit: limit ?? 3 }),
      };
    }
    return {
      items: await retrieveFromScope(scope as MemoryScope, query, {
        registryId,
        projectId,
        limit: limit ?? 5,
      }),
    };
  });


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

      const looksLikeTemplate = (v: string | undefined): boolean =>
        typeof v === "string" && (v.includes("{{") || v.startsWith("${"));

      const ctx = parsed.context as Record<string, unknown> | undefined;
      const ctxIssue = ctx?.paperclipIssue as Record<string, unknown> | undefined;
      const taskMarkdown = ctx?.paperclipTaskMarkdown as string | undefined;

      // Persona lookup desde el registry segun agentId que Paperclip nos pasa
      const persona = parsed.agentId
        ? resolvePersonaByPaperclipId(parsed.agentId)
        : null;

      // Workspace resolution:
      //   PRIORIDAD: registry/project-workspaces.json (paths del HOST).
      //   Paperclip inyecta paperclipWorkspace.cwd con paths internos del container
      //   (ej. "/paperclip/instances/.../projects/..."), que NO existen en el host
      //   donde corre el bridge. Si usamos esos cwd, spawn de hermes da exitCode 127
      //   (ENOENT). Asi que ignoramos paperclipWorkspace por completo para cwd y
      //   confiamos solo en nuestro map local.
      const ctxProjectId =
        (ctxIssue?.projectId as string | undefined) ??
        (ctx?.projectId as string | undefined);
      const workspace: ProjectWorkspace | null = ctxProjectId
        ? resolveWorkspaceByProjectId(ctxProjectId)
        : null;

      app.log.info(
        {
          bodyKeys: Object.keys(req.body as object),
          contextIssueId: ctx?.issueId,
          contextTaskId: ctx?.taskId,
          paperclipIssueKeys: ctxIssue ? Object.keys(ctxIssue) : null,
          hasTaskMarkdown: Boolean(taskMarkdown),
          taskMarkdownLen: taskMarkdown?.length ?? 0,
          personaRegistryId: persona?.registryId,
          personaName: persona?.agentName,
          personaCli: persona?.preferredModel?.cli,
          workspaceSource: workspace ? "registry" : "default-cwd",
          workspaceCwd: workspace?.cwd ?? null,
          workspaceProject: workspace?.projectName ?? null,
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

      // Determina cual API key Paperclip usar:
      //   1. Si el agente esta en el registry y tiene su token: usa ese
      //   2. Si no: usa el generico (AICOS Hermes) si esta configurado
      const apiKeyForCallbacks = persona?.apiKey ?? opts.paperclipApiKey;
      const apiUrlForCallbacks = opts.paperclipApiUrl;

      let pcClient: PaperclipClient | undefined;
      if (issueId && apiUrlForCallbacks && apiKeyForCallbacks) {
        pcClient = new PaperclipClient(
          {
            apiUrl: apiUrlForCallbacks,
            apiKey: apiKeyForCallbacks,
          },
          parsed.runId,
        );

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

      setImmediate(async () => {
        try {
          const result = await executeRun({
            prompt: prompt!,
            model: parsed.model,
            provider: parsed.provider,
            persona: persona ?? undefined,
            workspace,
            ticketIdentifier: (ctxIssue?.identifier as string | undefined),
            paperclip:
              pcClient && issueId
                ? { client: pcClient, issueId }
                : undefined,
            quotaClient,
            learningClient,
          });
          app.log.info(
            {
              issueId,
              runId: parsed.runId,
              persona: persona?.registryId,
              mode: result.mode,
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
        persona: persona?.registryId ?? null,
      });
    },
  );

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}
