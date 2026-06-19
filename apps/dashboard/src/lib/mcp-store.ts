/**
 * Conectores MCP/tools. El dashboard gestiona la lista; al guardar genera la
 * config en formato Claude Code (~/.config/aicos/claude-mcp.json) que los
 * agentes (cli-direct) y el Strategy Room cargan con --mcp-config. Mismo home
 * montado → vale dentro del container.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const STORE_PATH = process.env.AICOS_MCP_STORE || join(HOME, ".config", "aicos", "mcp.json");
const CLAUDE_PATH = process.env.AICOS_MCP_CONFIG || join(HOME, ".config", "aicos", "claude-mcp.json");

export type Transport = "stdio" | "http" | "sse";
export interface McpServer {
  id: string;
  name: string;
  description?: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** Catálogo de los MCP más usados (el usuario completa keys/args y los habilita). */
export const MCP_CATALOG: Omit<McpServer, "enabled">[] = [
  { id: "filesystem", name: "Filesystem", description: "Leer/escribir archivos de una carpeta", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/vagrant"] },
  { id: "github", name: "GitHub", description: "Repos, issues, PRs, código", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } },
  { id: "postgres", name: "PostgreSQL", description: "Consultar una base Postgres (poné la conn string en args)", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host:5432/db"] },
  { id: "brave", name: "Brave Search", description: "Búsqueda web", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" } },
  { id: "fetch", name: "Fetch (web)", description: "Traer y leer páginas web", transport: "stdio", command: "npx", args: ["-y", "@kazuph/mcp-fetch"] },
  { id: "slack", name: "Slack", description: "Leer/postear en Slack", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" } },
  { id: "puppeteer", name: "Navegador (Puppeteer)", description: "Automatizar un navegador", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
  { id: "memory", name: "Memory (knowledge graph)", description: "Memoria persistente tipo grafo", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  { id: "custom-http", name: "Custom (HTTP/SSE)", description: "Un servidor MCP propio por URL (ej: n8n, Supabase)", transport: "http", url: "https://tu-servidor/mcp" },
];

export function listServers(): McpServer[] {
  try {
    const d = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return Array.isArray(d) ? d : (d.servers ?? []);
  } catch {
    return [];
  }
}

function toClaudeConfig(servers: McpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    if (!s.enabled) continue;
    if (s.transport === "stdio") {
      mcpServers[s.id] = { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };
    } else {
      mcpServers[s.id] = { type: s.transport, url: s.url, ...(s.env && Object.keys(s.env).length ? { headers: s.env } : {}) };
    }
  }
  return { mcpServers };
}

function persist(servers: McpServer[]): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify({ servers }, null, 2));
  // Config que cargan los agentes / Strategy Room.
  writeFileSync(CLAUDE_PATH, JSON.stringify(toClaudeConfig(servers), null, 2));
}

export function upsertServer(input: Partial<McpServer>): McpServer {
  const all = listServers();
  const id = (input.id || input.name || "mcp").toString().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "mcp";
  const existing = all.find((x) => x.id === id);
  const s: McpServer = {
    id,
    name: input.name || id,
    description: input.description,
    transport: input.transport || "stdio",
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    enabled: input.enabled ?? true,
  };
  persist(existing ? all.map((x) => (x.id === id ? s : x)) : [...all, s]);
  return s;
}

export function deleteServer(id: string): void {
  persist(listServers().filter((x) => x.id !== id));
}
