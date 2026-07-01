/**
 * Gate de tests (#9).
 *
 * Antes de dar un ticket por DONE, si el agente trabajó sobre un workspace y el
 * gate está activo, corremos los tests del proyecto. Si fallan, el run pasa a
 * fallido → no se commitea código roto, el ticket se bloquea y entra al motor de
 * reintentos (#7).
 *
 * Detección del comando de tests (en orden):
 *   1. override por proyecto en config.perProject[projectName]
 *   2. config.command global
 *   3. package.json con scripts.test "real" → `npm test`
 *   4. Makefile con target `test:` → `make test`
 *   5. nada → se saltea (ran=false)
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.HOME || "/home/vagrant";
const CFG_PATH = process.env.AICOS_TESTGATE_CONFIG || join(HOME, ".config", "aicos", "test-gate.json");

export interface TestGateConfig {
  enabled: boolean;
  command?: string;                       // override global
  timeoutSec: number;
  perProject?: Record<string, string>;    // projectName → comando
}

const DEFAULTS: TestGateConfig = { enabled: true, timeoutSec: 300 };

export function loadTestGateConfig(): TestGateConfig {
  try {
    const d = JSON.parse(readFileSync(CFG_PATH, "utf8"));
    return {
      enabled: d.enabled !== false,
      command: typeof d.command === "string" && d.command.trim() ? d.command.trim() : undefined,
      timeoutSec: Number.isFinite(d.timeoutSec) && d.timeoutSec > 0 ? Math.min(d.timeoutSec, 1800) : DEFAULTS.timeoutSec,
      perProject: d.perProject && typeof d.perProject === "object" ? d.perProject : undefined,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTestGateConfig(cfg: Partial<TestGateConfig>): TestGateConfig {
  const cur = loadTestGateConfig();
  const next: TestGateConfig = {
    enabled: cfg.enabled ?? cur.enabled,
    command: cfg.command !== undefined ? (cfg.command.trim() || undefined) : cur.command,
    timeoutSec: cfg.timeoutSec ?? cur.timeoutSec,
    perProject: cfg.perProject ?? cur.perProject,
  };
  mkdirSync(dirname(CFG_PATH), { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(next, null, 2));
  return next;
}

/** Decide qué comando de tests correr en este workspace (o null si no hay). */
export function detectTestCommand(cwd: string, projectName: string | undefined, cfg: TestGateConfig): string | null {
  if (projectName && cfg.perProject?.[projectName]) return cfg.perProject[projectName];
  if (cfg.command) return cfg.command;
  // package.json con un script test "real" (no el placeholder de npm init).
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const t = pkg.scripts?.test;
      if (t && !/no test specified/i.test(t)) return "npm test --silent";
    } catch { /* sigue */ }
  }
  // Makefile con target test
  const mk = join(cwd, "Makefile");
  if (existsSync(mk)) {
    try {
      if (/^test:/m.test(readFileSync(mk, "utf8"))) return "make test";
    } catch { /* sigue */ }
  }
  return null;
}

export interface TestGateResult {
  ran: boolean;
  passed: boolean;
  exitCode: number;
  command?: string;
  output: string;       // cola combinada stdout+stderr
  timedOut?: boolean;
}

function runCommand(cwd: string, command: string, timeoutSec: number): Promise<TestGateResult> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let out = "";
    const cap = (c: Buffer) => { out += c.toString("utf8"); if (out.length > 200_000) out = out.slice(-200_000); };
    proc.stdout.on("data", cap);
    proc.stderr.on("data", cap);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch { /* noop */ } }, timeoutSec * 1000);
    proc.on("error", (e) => {
      clearTimeout(t);
      resolve({ ran: true, passed: false, exitCode: 127, command, output: `spawn error: ${e.message}` });
    });
    proc.on("exit", (code) => {
      clearTimeout(t);
      const tail = out.trim().split("\n").slice(-60).join("\n").slice(-4000);
      resolve({
        ran: true,
        passed: !timedOut && code === 0,
        exitCode: code ?? 1,
        command,
        output: timedOut ? `⏱ timeout tras ${timeoutSec}s\n${tail}` : tail,
        timedOut,
      });
    });
  });
}

// Salidas típicas de los runners cuando el proyecto NO tiene tests todavía.
// "No hay tests aún" ≠ "tests rotos": vitest/jest/mocha salen con exit 1 y
// pytest con exit 5 al no encontrar archivos, lo que bloqueaba para siempre
// los tickets de scaffolding greenfield (el gate era imposible de pasar).
const NO_TESTS_PATTERNS: RegExp[] = [
  /no test files? found/i, // vitest, mocha
  /no tests? found/i, // jest
  /no tests ran/i, // pytest
  /couldn't find any test files/i,
];

/** Corre el gate de tests en el workspace. Si no aplica, devuelve ran=false. */
export async function runTestGate(cwd: string, projectName?: string): Promise<TestGateResult> {
  const cfg = loadTestGateConfig();
  if (!cfg.enabled) return { ran: false, passed: true, exitCode: 0, output: "" };
  const command = detectTestCommand(cwd, projectName, cfg);
  if (!command) return { ran: false, passed: true, exitCode: 0, output: "" };
  process.stderr.write(`[test-gate] running "${command}" in ${cwd}\n`);
  const result = await runCommand(cwd, command, cfg.timeoutSec);
  if (!result.passed && !result.timedOut && NO_TESTS_PATTERNS.some((re) => re.test(result.output))) {
    process.stderr.write(`[test-gate] no test files in workspace — treating as pass\n`);
    return {
      ...result,
      passed: true,
      output: `(sin archivos de test aún — gate salteado)\n${result.output}`,
    };
  }
  return result;
}
