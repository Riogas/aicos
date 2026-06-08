import IORedis from "ioredis";
import { createPolicyClient } from "./policy-client.js";
import { startServer } from "./server.js";

const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(`aicos-tool-gateway ${VERSION}

Proxy + audit + policy gate for agent tool access.

Usage:
  aicos-tool-gateway --serve [--port <n>]

Env:
  GATEWAY_PORT             default 7004
  REDIS_URL                default redis://localhost:6379
  POLICY_SERVICE_URL       optional — gateway consults policy before each tool call
  GATEWAY_ENABLED          "true"|"false" (default true)
  GITHUB_TOKEN             optional — when set, /github/issue with dryRun=false actually creates

Endpoints:
  GET    /health
  GET    /audit/recent          last 50 audit entries today

  POST   /github/issue          body: { actor, owner, repo, title, body?, labels?, dryRun? }
  POST   /docker                body: { actor, cmd: ps|logs|inspect|stats, containerName?, tailLines? }
  POST   /browser/fetch         body: { actor, url, method?: GET|HEAD, asText? }
  POST   /shell                 body: { actor, cmd: <ls|cat|head|tail|wc|git>, cwd?, timeoutMs? }
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`aicos-tool-gateway ${VERSION}\n`);
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
      : Number(process.env.GATEWAY_PORT) || 7004;

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const gatewayEnabled = (process.env.GATEWAY_ENABLED ?? "true").toLowerCase() !== "false";
  const policyClient = createPolicyClient(process.env.POLICY_SERVICE_URL);

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", (e) => process.stderr.write(`[gateway] redis: ${e.message}\n`));

  const app = await startServer({ port, redis, policyClient, gatewayEnabled });
  app.log.info(
    {
      port,
      gatewayEnabled,
      policy: policyClient.isEnabled() ? "enabled" : "disabled",
      githubToken: process.env.GITHUB_TOKEN ? "configured" : "missing (dry-run only)",
    },
    "aicos-tool-gateway listening",
  );

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
    process.stderr.write(`[gateway] FATAL: ${(e as Error).message}\n`);
    process.exit(1);
  });
