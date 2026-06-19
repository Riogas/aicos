// Migra los agentes ya onboarded (agent-keys.json) al adapter `process`.
// Se usa cuando el onboarding los dejo en `http` (p.ej. strict secret mode
// rechazaba el AICOS_API_KEY inline). Idempotente.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const API_BASE   = process.env.PAPERCLIP_URL || "http://localhost:3100";
const BOARD_TOKEN= process.env.PAPERCLIP_BOARD_TOKEN || "";
const HOST_HOME  = process.env.AICOS_HOST_HOME || homedir();
const AICOS_ROOT = process.env.AICOS_ROOT || `${HOST_HOME}/aicos`;
const KEYS_PATH  = `${AICOS_ROOT}/.secrets/agent-keys.json`;

function processAdapterConfig(apiKey) {
  return {
    command: "/usr/local/bin/node",
    args: [`${AICOS_ROOT}/apps/paperclip-bridge/dist/index.js`, "--paperclip-process-mode"],
    cwd: HOST_HOME,
    timeoutSec: 2400,
    env: {
      HOME: HOST_HOME,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      AICOS_ROOT,
      AICOS_API_KEY: apiKey,
      AICOS_ENABLED_CLIS: process.env.AICOS_ENABLED_CLIS || "claude",
      // El agente corre como root dentro del container; claude rechaza
      // --dangerously-skip-permissions como root salvo que IS_SANDBOX=1 declare
      // un entorno sandboxeado (el container lo es).
      IS_SANDBOX: "1",
      AICOS_EMBEDDINGS_URL: "http://host.docker.internal:7080/embed",
      AICOS_EMBEDDINGS_DIM: "384",
      QUOTA_SERVICE_URL:   "http://host.docker.internal:7001",
      POLICY_SERVICE_URL:  "http://host.docker.internal:7002",
      LEARNING_SERVICE_URL:"http://host.docker.internal:7003",
    },
  };
}

if (!BOARD_TOKEN) { console.error("falta PAPERCLIP_BOARD_TOKEN"); process.exit(1); }
const keys = JSON.parse(await readFile(KEYS_PATH, "utf8"));
let ok = 0, fail = 0;
for (const [regId, info] of Object.entries(keys)) {
  const agentId = info.paperclipAgentId;
  if (!agentId || !info.apiKey) { console.log("SKIP", regId, "(sin agentId/apiKey)"); continue; }
  const res = await fetch(`${API_BASE}/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BOARD_TOKEN}` },
    body: JSON.stringify({
      adapterType: "process",
      adapterConfig: processAdapterConfig(info.apiKey),
      replaceAdapterConfig: true,
    }),
  });
  if (res.ok) { ok++; console.log("OK  ", regId); }
  else { fail++; console.log("FAIL", regId, res.status, (await res.text().catch(()=> "")).slice(0,120)); }
}
console.log(`\n=== process adapter: OK=${ok} FAIL=${fail} ===`);
