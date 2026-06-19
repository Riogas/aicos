import { readFileSync } from "node:fs";
import { runHermesOneshot } from "./hermes.js";
import { startServer } from "./server.js";
import { runPaperclipProcessMode } from "./paperclip-process-mode.js";
import { startScheduler } from "./scheduler.js";

const VERSION = "0.3.0";

function printHelp(): void {
  process.stdout.write(`aicos-bridge ${VERSION}

Modos:

  1. CLI directo (simulate)
     aicos-bridge [--prompt <text>] [--model <m>] [--provider <p>]
     aicos-bridge < prompt_from_stdin.txt

  2. HTTP server (daemon)
     aicos-bridge --serve [--port <n>]
        env BRIDGE_PORT (default 7100)
        env PAPERCLIP_API_URL  ej http://localhost:3100
        env PAPERCLIP_API_KEY  agent api key

     Endpoints:
        GET  /health
        GET  /in-flight
        POST /run
           body: { issueId? prompt? model? provider? runId? agentId? }

  3. Paperclip process-adapter mode (spawned by Paperclip)
     aicos-bridge --paperclip-process-mode
        env PAPERCLIP_AGENT_ID    auto-injected
        env PAPERCLIP_COMPANY_ID  auto-injected
        env PAPERCLIP_API_URL     auto-injected
        env PAPERCLIP_API_KEY     must be in agent.adapter_config.env
        env PAPERCLIP_RUN_ID      optional, run id
     Lookup current assigned issue, execute run, exit 0/1.
     Paperclip captures exit code + stdout natively (no watchdog mismatch).

Comandos rapidos:
  aicos-bridge --version
  aicos-bridge --help

Exit codes:
  0 ok | 1 error de runtime | 2 uso | 127 hermes missing
`);
}

function getArgValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function readStdinSync(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    const data = readFileSync(0, "utf-8").trim();
    return data || null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    process.stdout.write(`aicos-bridge ${VERSION}\n`);
    return 0;
  }

  // Paperclip process-adapter mode: invoked by Paperclip subprocess.
  // Reads PAPERCLIP_* env, picks the assigned issue, runs, exits 0/1.
  // Paperclip captures exit code + stdout natively → no watchdog mismatch.
  if (args.includes("--paperclip-process-mode")) {
    return runPaperclipProcessMode();
  }

  if (args.includes("--serve")) {
    const portArg = getArgValue(args, "--port");
    const port = portArg
      ? Number.parseInt(portArg, 10)
      : Number(process.env.BRIDGE_PORT) || 7100;

    const app = await startServer({
      port,
      paperclipApiUrl: process.env.PAPERCLIP_API_URL,
      paperclipApiKey: process.env.PAPERCLIP_API_KEY,
      quotaServiceUrl: process.env.QUOTA_SERVICE_URL,
      learningServiceUrl: process.env.LEARNING_SERVICE_URL,
      policyServiceUrl: process.env.POLICY_SERVICE_URL,
    });
    app.log.info(
      {
        port,
        paperclipConfigured: Boolean(process.env.PAPERCLIP_API_URL),
        quotaConfigured: Boolean(process.env.QUOTA_SERVICE_URL),
        learningConfigured: Boolean(process.env.LEARNING_SERVICE_URL),
      },
      "aicos-bridge listening",
    );
    // Scheduler de tareas programadas — solo en el bridge host (serve).
    startScheduler();
    return -1; // sentinela: nunca termina por su cuenta
  }

  const prompt = getArgValue(args, "--prompt") ?? readStdinSync();
  if (!prompt) {
    process.stderr.write(
      "aicos-bridge: no prompt. Use --prompt <text>, pipe via stdin, o --serve.\n",
    );
    return 2;
  }

  const model = getArgValue(args, "--model");
  const provider = getArgValue(args, "--provider");
  return runHermesOneshot({ prompt, model, provider });
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
    // code === -1 (server mode) -> dejamos el event loop vivo
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`aicos-bridge: fatal: ${msg}\n`);
    process.exit(1);
  });
