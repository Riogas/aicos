/**
 * Explorador de repos/apps. Escanea una carpeta raíz configurable y detecta las
 * subcarpetas que son repos (.git) o apps (manifests). Config en
 * ~/.config/aicos/repos-config.json (mismo home montado que ven los agentes, así
 * los paths sirven dentro del container).
 */
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const CONFIG_PATH = process.env.AICOS_REPOS_CONFIG || join(HOME, ".config", "aicos", "repos-config.json");

export interface RepoConfig { root: string }
export interface RepoInfo {
  name: string;
  path: string;
  git: boolean;
  branch?: string;
  kind: string;       // node / python / go / rust / docker / repo / folder…
  description?: string;
}

export function getConfig(): RepoConfig {
  try { return { root: JSON.parse(readFileSync(CONFIG_PATH, "utf8")).root || HOME }; }
  catch { return { root: HOME }; }
}

export function setRoot(root: string): RepoConfig {
  const r = resolve(root);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ root: r }, null, 2));
  return { root: r };
}

function detectKind(p: string): { kind: string; description?: string } {
  const has = (f: string) => existsSync(join(p, f));
  let description: string | undefined;
  try {
    if (has("package.json")) {
      const pkg = JSON.parse(readFileSync(join(p, "package.json"), "utf8"));
      description = pkg.description || undefined;
      return { kind: pkg.dependencies?.next ? "next" : "node", description };
    }
  } catch { /* */ }
  // README primera línea como descripción
  for (const rd of ["README.md", "readme.md", "README"]) {
    if (has(rd)) {
      try {
        const first = readFileSync(join(p, rd), "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"));
        if (first) description = first.trim().slice(0, 140);
      } catch { /* */ }
      break;
    }
  }
  if (has("requirements.txt") || has("pyproject.toml")) return { kind: "python", description };
  if (has("go.mod")) return { kind: "go", description };
  if (has("Cargo.toml")) return { kind: "rust", description };
  if (has("composer.json")) return { kind: "php", description };
  if (has("Dockerfile") || has("docker-compose.yml")) return { kind: "docker", description };
  return { kind: existsSync(join(p, ".git")) ? "repo" : "folder", description };
}

function gitBranch(p: string): string | undefined {
  try {
    const head = readFileSync(join(p, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref:") ? head.split("/").pop() : head.slice(0, 8);
  } catch { return undefined; }
}

export function scanRepos(root: string): RepoInfo[] {
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  const out: RepoInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(root, name);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const git = existsSync(join(p, ".git"));
    const { kind, description } = detectKind(p);
    // mostramos solo repos o apps (no carpetas sueltas vacías)
    if (!git && kind === "folder") continue;
    out.push({ name, path: p, git, branch: git ? gitBranch(p) : undefined, kind, description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** ¿`p` está dentro de la raíz configurada? (anti path-traversal) */
export function isUnderRoot(p: string): boolean {
  const root = resolve(getConfig().root);
  const rp = resolve(p);
  return rp === root || rp.startsWith(root + "/");
}

export function listDir(p: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(p)
      .filter((n) => !n.startsWith(".git"))
      .map((n) => {
        let dir = false;
        try { dir = statSync(join(p, n)).isDirectory(); } catch { /* */ }
        return { name: n, dir };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, 200);
  } catch { return []; }
}

export function readReadme(p: string): string | null {
  for (const rd of ["README.md", "readme.md", "README"]) {
    try { return readFileSync(join(p, rd), "utf8").slice(0, 6000); } catch { /* */ }
  }
  return null;
}
