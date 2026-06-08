import { loadRuleset } from "./rules.js";
import { startServer } from "./server.js";

const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(`aicos-policy-engine ${VERSION}

HTTP service that evaluates whether an action requires approval/deny/allow
given a configurable ruleset.

Usage:
  aicos-policy-engine --serve [--port <n>]

Env:
  POLICY_PORT            default 7002
  POLICY_RULES_FILE      path to ruleset.json (default: built-in)
  POLICY_ENABLED         "true"|"false" (default true) — false passes everything through

Endpoints:
  GET   /health
  GET   /rules           current ruleset
  POST  /evaluate        body: { actor, action, resource?, bucket?, riskFlags?, estimatedCostUsd?, approved? }
                         returns: { decision, reason, matchedRule?, evaluated }
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`aicos-policy-engine ${VERSION}\n`);
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
      : Number(process.env.POLICY_PORT) || 7002;

  const ruleset = loadRuleset(process.env.POLICY_RULES_FILE);
  const policyEnabled = (process.env.POLICY_ENABLED ?? "true").toLowerCase() !== "false";

  const app = await startServer({ port, ruleset, policyEnabled });
  app.log.info(
    { port, policyEnabled, ruleCount: ruleset.rules.length },
    "aicos-policy-engine listening",
  );

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    try {
      await app.close();
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
  .then((code) => {
    if (code !== 0 && code !== undefined) process.exit(code);
  })
  .catch((e) => {
    process.stderr.write(`[policy] FATAL: ${(e as Error).message}\n`);
    process.exit(1);
  });
