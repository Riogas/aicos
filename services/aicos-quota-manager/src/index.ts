import IORedis from "ioredis";
import { loadBudgets } from "./budgets.js";
import { InMemoryQuotaManager } from "./quota-memory.js";
import { RedisQuotaManager } from "./quota-redis.js";
import { startServer } from "./server.js";

const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(`aicos-quota-manager ${VERSION}

Standalone HTTP service for per-provider quota tracking + survival routing.

Usage:
  aicos-quota-manager --serve [--port <n>]

Env:
  QUOTA_PORT            default 7001
  REDIS_URL             default redis://localhost:6379 (use "memory" for in-memory)
  QUOTA_BUDGETS_FILE    path to budgets.json (default: built-in)
  QUOTA_ENABLED         "true"|"false" (default true) — false makes /select pass-through

Endpoints:
  GET    /health
  GET    /status
  POST   /usage         body: { provider, cli?, costUsd, requests?, tokens?, model?, agentRegistryId?, ticketId? }
  POST   /select        body: { role?, task?, candidates: [{cli,model,provider}] }
  POST   /providers/:name/down   body: { cooldownSec, reason? }
  DELETE /providers/:name/down

Exit codes:
  0 ok | 1 runtime error | 2 usage
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`aicos-quota-manager ${VERSION}\n`);
    return 0;
  }
  if (!args.includes("--serve")) {
    printHelp();
    return 2;
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 && args[portIdx + 1]
    ? Number.parseInt(args[portIdx + 1]!, 10)
    : Number(process.env.QUOTA_PORT) || 7001;

  const budgets = loadBudgets(process.env.QUOTA_BUDGETS_FILE);
  const quotaEnabled = (process.env.QUOTA_ENABLED ?? "true").toLowerCase() !== "false";
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  let manager;
  let cleanup: (() => Promise<void>) | undefined;

  if (redisUrl === "memory") {
    process.stderr.write("[quota] using in-memory manager (REDIS_URL=memory)\n");
    manager = new InMemoryQuotaManager(budgets);
  } else {
    const redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    redis.on("error", (e) => process.stderr.write(`[quota] redis: ${e.message}\n`));
    await new Promise<void>((resolve) => {
      if (redis.status === "ready") return resolve();
      redis.once("ready", () => resolve());
      redis.once("error", () => resolve()); // even on error, server still starts
    });
    manager = new RedisQuotaManager(redis, budgets);
    cleanup = async () => {
      try {
        await redis.quit();
      } catch {
        /* noop */
      }
    };
  }

  const app = await startServer({ port, manager, quotaEnabled });
  app.log.info(
    {
      port,
      quotaEnabled,
      criticalProvider: budgets.criticalProvider,
      providers: Object.keys(budgets.providers),
      clis: Object.keys(budgets.clis),
      mode: redisUrl === "memory" ? "in-memory" : "redis",
    },
    "aicos-quota-manager listening",
  );

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    try {
      await app.close();
    } finally {
      if (cleanup) await cleanup();
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return new Promise(() => {}); // keep running
}

main()
  .then((code) => {
    if (code !== 0 && code !== undefined) process.exit(code);
  })
  .catch((e) => {
    process.stderr.write(`[quota] FATAL: ${(e as Error).message}\n`);
    process.exit(1);
  });
