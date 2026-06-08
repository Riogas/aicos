import IORedis from "ioredis";
import { RedisLearningStore } from "./store.js";
import { startServer } from "./server.js";

const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(`aicos-learning ${VERSION}

Captures run outcomes and recommends best provider/model per task_type.

Usage:
  aicos-learning --serve [--port <n>]

Env:
  LEARNING_PORT          default 7003
  REDIS_URL              default redis://localhost:6379
  LEARNING_ENABLED       "true"|"false" (default true)

Endpoints:
  GET    /health
  POST   /outcome      body: { provider, cli, model, taskType, success, durationMs, costUsd, ... }
  GET    /best-for     ?taskType=critical&minSamples=3 -> ranking + best recommendation
  GET    /recent       last 50 outcomes today
  GET    /summary      best-for ALL task types
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`aicos-learning ${VERSION}\n`);
    return 0;
  }
  if (!args.includes("--serve")) {
    printHelp();
    return 2;
  }

  const portIdx = args.indexOf("--port");
  const port =
    portIdx >= 0 && args[portIdx + 1]
      ? Number.parseInt(args[portIdx + 1]!, 10)
      : Number(process.env.LEARNING_PORT) || 7003;

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const learningEnabled = (process.env.LEARNING_ENABLED ?? "true").toLowerCase() !== "false";

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", (e) => process.stderr.write(`[learning] redis: ${e.message}\n`));
  const store = new RedisLearningStore(redis);

  const app = await startServer({ port, store, learningEnabled });
  app.log.info({ port, learningEnabled }, "aicos-learning listening");

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    try {
      await app.close();
      await redis.quit();
    } catch {
      /* noop */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return new Promise(() => {});
}

main()
  .then((c) => {
    if (c !== 0 && c !== undefined) process.exit(c);
  })
  .catch((e) => {
    process.stderr.write(`[learning] FATAL: ${(e as Error).message}\n`);
    process.exit(1);
  });
