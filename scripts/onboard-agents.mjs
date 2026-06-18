#!/usr/bin/env node
/**
 * AICOS — Onboarding masivo de agentes a Paperclip.
 *
 * Lee ~/aicos/registry/agents.json, para cada agente:
 *  1. POST /api/invites/<INVITE_TOKEN>/accept  (adapterType: process)
 *  2. Guarda requestId + claimSecret en .secrets/agent-onboarding-state.json
 *  3. Approval:
 *     - con PAPERCLIP_BOARD_TOKEN en env (modo installer): auto-aprueba via
 *       POST /api/companies/<companyId>/join-requests/<id>/approve
 *     - sin board token: polling cada 5s hasta que el operador apruebe en la UI
 *  4. Cuando esta aprobado: POST /api/join-requests/<requestId>/claim-api-key
 *  5. PATCH /api/agents/<agentId> → adapter `process` apuntando a aicos-bridge
 *     --paperclip-process-mode con AICOS_API_KEY en adapter_config.env
 *     (requiere PAPERCLIP_BOARD_TOKEN; sin el, queda en http y hay que
 *     migrarlo a mano)
 *  6. Guarda la API key en .secrets/agent-keys.json
 *  7. Updatea registry/agents.json con el paperclipAgentId real
 *
 * Idempotente: si vuelve a correrse, salta agentes ya completados.
 *
 * Uso:
 *   node scripts/onboard-agents.mjs --invite=<inviteToken> [--api=<url>]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REGISTRY_PATH = resolve(ROOT, "registry/agents.json");
const SECRETS_DIR = resolve(ROOT, ".secrets");
const STATE_PATH = resolve(SECRETS_DIR, "agent-onboarding-state.json");
const KEYS_PATH = resolve(SECRETS_DIR, "agent-keys.json");

// CLI args
const argMap = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const INVITE_ID = argMap.invite || process.env.AICOS_INVITE_TOKEN || "";
const API_BASE = argMap.api || "http://localhost:3100";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// Modo installer: con board token aprobamos y parcheamos agentes sin UI.
const BOARD_TOKEN = process.env.PAPERCLIP_BOARD_TOKEN || "";

const BRIDGE_URL = "http://host.docker.internal:7100/run";
const PAPERCLIP_FROM_BRIDGE = "http://host.docker.internal:3100";

// Config del adapter `process` (lo que Paperclip spawnea dentro del container
// de Paperclip — el home del host esta montado al mismo path, ver compose).
const HOST_HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/jgomez";
const AICOS_ROOT = process.env.AICOS_ROOT || ROOT;

function processAdapterConfig(apiKey) {
  return {
    command: "/usr/local/bin/node",
    args: [
      `${AICOS_ROOT}/apps/paperclip-bridge/dist/index.js`,
      "--paperclip-process-mode",
    ],
    cwd: HOST_HOME,
    // 40 min: una tarea pesada (arquitectura / scaffolding de varios modulos)
    // no cierra en 10 min; con 600s Paperclip mataba el run por timeout y lo
    // relanzaba de cero -> loop infinito sin progreso. Override por agente si hace falta.
    timeoutSec: 2400,
    env: {
      HOME: HOST_HOME,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      AICOS_ROOT,
      AICOS_API_KEY: apiKey,
      // CLIs habilitadas/autenticadas. La imagen de Paperclip trae
      // claude/codex/opencode instalados, pero el bridge solo debe usar las que
      // el operador autenticó — el resto se saltea en el fallback chain (ver
      // isCliAvailable). Default claude-only; override con AICOS_ENABLED_CLIS.
      AICOS_ENABLED_CLIS: process.env.AICOS_ENABLED_CLIS || "claude",
      // El agente corre como root dentro del container de Paperclip; claude
      // rechaza --dangerously-skip-permissions como root salvo que IS_SANDBOX=1
      // declare un entorno sandboxeado (el container lo es).
      IS_SANDBOX: "1",
      QUOTA_SERVICE_URL: "http://host.docker.internal:7001",
      POLICY_SERVICE_URL: "http://host.docker.internal:7002",
      LEARNING_SERVICE_URL: "http://host.docker.internal:7003",
    },
  };
}

function log(...args) {
  console.log("[onboard]", ...args);
}
function warn(...args) {
  console.warn("[onboard][WARN]", ...args);
}
function fatal(msg) {
  console.error("[onboard][FATAL]", msg);
  process.exit(1);
}

async function loadJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== null) return fallback;
    throw e;
  }
}

async function saveJson(path, data, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", { mode });
}

// Paperclip invites son de UN SOLO USO: al aceptarlos se estampa accepted_at y
// el server rechaza el siguiente accept con "Invite already consumed". Por eso
// en modo installer creamos un invite fresco por agente (necesita board token).
async function createInvite(companyId) {
  const res = await fetch(`${API_BASE}/api/companies/${companyId}/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOARD_TOKEN}`,
    },
    body: JSON.stringify({ allowedJoinTypes: "agent" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createInvite: ${res.status} ${res.statusText} ${text}`);
  }
  const inv = await res.json();
  return inv.token;
}

async function submitJoinRequest(agent, inviteToken = INVITE_ID) {
  // El join request entra como http (payload liviano); el PATCH post-claim lo
  // migra a `process` con la API key real (chicken-and-egg: la key no existe
  // hasta el claim).
  const body = {
    requestType: "agent",
    agentName: agent.name,
    adapterType: "http",
    capabilities: agent.capabilities ?? "",
    agentDefaultsPayload: {
      url: BRIDGE_URL,
      paperclipApiUrl: PAPERCLIP_FROM_BRIDGE,
      payloadTemplate: {
        prompt: "{{issue.title}}\n\n{{issue.description}}",
        issueId: "{{issue.id}}",
      },
      aicosAgentRegistryId: agent.id,
      aicosDepartment: agent.department,
    },
  };
  const res = await fetch(`${API_BASE}/api/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`submit ${agent.id}: ${res.status} ${res.statusText} ${text}`);
  }
  return await res.json();
}

async function getJoinRequestStatus(requestId) {
  const candidates = [
    `${API_BASE}/api/join-requests/${requestId}`,
    `${API_BASE}/api/invites/${INVITE_ID}/join-requests/${requestId}`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

async function approveJoinRequest(companyId, requestId) {
  const res = await fetch(
    `${API_BASE}/api/companies/${companyId}/join-requests/${requestId}/approve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BOARD_TOKEN}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`approve ${requestId}: ${res.status} ${res.statusText} ${text}`);
  }
  return await res.json();
}

async function patchAgentToProcessAdapter(agentId, apiKey) {
  const res = await fetch(`${API_BASE}/api/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOARD_TOKEN}`,
    },
    body: JSON.stringify({
      adapterType: "process",
      adapterConfig: processAdapterConfig(apiKey),
      replaceAdapterConfig: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`patch ${agentId}: ${res.status} ${res.statusText} ${text}`);
  }
  return await res.json();
}

async function claimApiKey(requestId, claimSecret) {
  const res = await fetch(
    `${API_BASE}/api/join-requests/${requestId}/claim-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimSecret }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`claim ${requestId}: ${res.status} ${res.statusText} ${text}`);
  }
  return await res.json();
}

async function pollUntilApprovedOrTimeout(state) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    let pendingCount = 0;
    for (const entry of Object.values(state.byAgent)) {
      if (entry.status === "claimed") continue;

      // Modo installer: aprobamos nosotros mismos con el board token.
      const companyId = entry.companyId || process.env.AICOS_COMPANY_ID || "";
      if (
        BOARD_TOKEN &&
        companyId &&
        entry.status !== "approved" &&
        entry.status !== "rejected" &&
        !entry.token
      ) {
        try {
          await approveJoinRequest(companyId, entry.requestId);
          entry.status = "approved";
          log(`✓ ${entry.agentRegistryId} auto-approved`);
        } catch (e) {
          // 409/conflict = ya aprobado; cualquier otra cosa la vemos en el poll.
          if (!/409/.test(e.message)) warn(`auto-approve ${entry.agentRegistryId}: ${e.message}`);
        }
      }

      if (entry.status !== "approved" || !entry.statusInfo) {
        const info = await getJoinRequestStatus(entry.requestId);
        if (info && info.status && info.status !== entry.status) {
          entry.status = info.status;
          entry.statusInfo = {
            approvedAt: info.approvedAt,
            rejectedAt: info.rejectedAt,
            createdAgentId: info.createdAgentId,
          };
        }
      }
      if (entry.status === "approved" && !entry.token) {
        try {
          const result = await claimApiKey(entry.requestId, entry.claimSecret);
          entry.token = result.token;
          entry.agentId = result.agentId;
          entry.keyId = result.keyId;
          entry.status = "claimed";
          log(`✓ ${entry.agentRegistryId} claimed (agentId ${result.agentId.slice(0, 8)}…)`);
        } catch (e) {
          warn(`claim failed for ${entry.agentRegistryId}: ${e.message}`);
        }
      }
      // Post-claim: migrar al adapter process (estado canonico Path A).
      if (entry.status === "claimed" && entry.token && entry.agentId && !entry.processAdapter) {
        if (BOARD_TOKEN) {
          try {
            await patchAgentToProcessAdapter(entry.agentId, entry.token);
            entry.processAdapter = true;
            log(`✓ ${entry.agentRegistryId} → adapter process`);
          } catch (e) {
            warn(`patch a process fallo para ${entry.agentRegistryId}: ${e.message}`);
          }
        } else {
          warn(
            `${entry.agentRegistryId} quedo con adapter http — sin PAPERCLIP_BOARD_TOKEN ` +
            `no puedo migrarlo a process. Re-corre con el token o migra a mano.`,
          );
          entry.processAdapter = false;
        }
      }
      if (entry.status !== "claimed") pendingCount++;
    }
    await saveJson(STATE_PATH, state);
    if (pendingCount === 0) return;
    process.stdout.write(`  pending approvals: ${pendingCount}\r`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  warn("polling timeout reached; quedan agentes pendientes");
}

async function main() {
  if (!INVITE_ID) {
    fatal("falta el invite token: --invite=<token> (o env AICOS_INVITE_TOKEN)");
  }
  log(`registry: ${REGISTRY_PATH}`);
  log(`paperclip API: ${API_BASE}`);
  log(`invite: ${INVITE_ID}`);
  log(BOARD_TOKEN ? "modo installer: auto-approve ON" : "sin board token: aprobar en la UI");

  const registry = await loadJson(REGISTRY_PATH);
  if (!registry || !Array.isArray(registry.agents)) {
    fatal("registry/agents.json invalido o sin campo 'agents'");
  }

  const state = await loadJson(STATE_PATH, {
    inviteId: INVITE_ID,
    apiBase: API_BASE,
    byAgent: {},
  });

  log(`agentes en registry: ${registry.agents.length}`);
  log(`agentes ya en state: ${Object.keys(state.byAgent).length}`);

  // Fase 1: submit join requests para los agentes nuevos
  for (const agent of registry.agents) {
    if (state.byAgent[agent.id]) {
      const entry = state.byAgent[agent.id];
      if (entry.status === "claimed") continue;
      log(`= ${agent.id} ya estaba en state (status=${entry.status})`);
      continue;
    }
    try {
      // Invite fresco por agente (single-use). Con board token lo creamos acá;
      // sin board token usamos el invite global (alcanza para 1 solo agente).
      let inviteToken = INVITE_ID;
      if (BOARD_TOKEN) {
        const companyId = process.env.AICOS_COMPANY_ID || "";
        if (!companyId) throw new Error("falta AICOS_COMPANY_ID para crear invites por agente");
        inviteToken = await createInvite(companyId);
      }
      const result = await submitJoinRequest(agent, inviteToken);
      state.byAgent[agent.id] = {
        agentRegistryId: agent.id,
        agentName: agent.name,
        requestId: result.id,
        companyId: result.companyId,
        claimSecret: result.claimSecret,
        status: result.status ?? "pending_approval",
        submittedAt: new Date().toISOString(),
      };
      log(`+ ${agent.id} submitted (requestId ${result.id.slice(0, 8)}…)`);
      await saveJson(STATE_PATH, state);
    } catch (e) {
      warn(`submit ${agent.id} fallo: ${e.message}`);
    }
  }

  // Fase 2: polling hasta approval + claim
  const pending = Object.values(state.byAgent).filter((e) => e.status !== "claimed");
  if (pending.length === 0) {
    log("Todos los agentes ya estan claimed. Nada que hacer.");
  } else {
    log("");
    if (BOARD_TOKEN) {
      log(`⏳ Auto-aprobando + claiming ${pending.length} join request(s)…`);
    } else {
      log(`⏳ Esperando que apruebes ${pending.length} join request(s) en la UI de Paperclip.`);
      log(`   URL: ${API_BASE.replace(/\/$/, "")}`);
      log(`   El script polling cada ${POLL_INTERVAL_MS / 1000}s y va a claim automatico cuando apruebes.`);
    }
    log("");
    await pollUntilApprovedOrTimeout(state);
  }

  // Fase 3: persistir keys en archivo dedicado + updatear registry con paperclipAgentId.
  // Merge sobre lo que ya exista (p.ej. la entrada "ceo" que escribe el installer
  // antes de este onboard) para no pisarla.
  const keys = (await loadJson(KEYS_PATH, {})) || {};
  for (const entry of Object.values(state.byAgent)) {
    if (entry.status === "claimed" && entry.token) {
      keys[entry.agentRegistryId] = {
        agentName: entry.agentName,
        paperclipAgentId: entry.agentId,
        // El bridge (registry.ts AgentKeyEntry) lee `token`; mantenemos `apiKey`
        // como alias para scripts que ya lo consumen (repair-adapters). Sin
        // `token`, buildIndex deja 0 agentes resolvables y todo run sale exit 2.
        token: entry.token,
        apiKey: entry.token,
        keyId: entry.keyId,
      };
    }
  }
  await saveJson(KEYS_PATH, keys, 0o600);
  log(`✓ ${Object.keys(keys).length} keys persisted en ${KEYS_PATH}`);

  // Update registry.json con paperclipAgentId
  let updated = 0;
  for (const agent of registry.agents) {
    const k = keys[agent.id];
    if (k && agent.paperclipAgentId !== k.paperclipAgentId) {
      agent.paperclipAgentId = k.paperclipAgentId;
      updated++;
    }
  }
  if (updated > 0) {
    await saveJson(REGISTRY_PATH, registry, 0o644);
    log(`✓ registry updated con ${updated} paperclipAgentId nuevos`);
  }

  log("");
  log("=== RESUMEN ===");
  const byStatus = {};
  for (const e of Object.values(state.byAgent)) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  }
  for (const [s, n] of Object.entries(byStatus)) {
    log(`  ${s}: ${n}`);
  }
}

main().catch((e) => {
  console.error("[onboard][FATAL]", e);
  process.exit(1);
});
