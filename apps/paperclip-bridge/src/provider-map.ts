import type { ModelPref } from "./registry.js";

export interface Candidate {
  cli: string;
  model: string;
  provider: string;
}

/**
 * Mapa de {cli, model} → provider para el Quota Manager.
 *
 * Reglas:
 *  - cli=claude → provider="anthropic" (subscripcion o API; ambas billing-side son anthropic)
 *  - cli=codex  → provider="openai"
 *  - cli=agy    → provider="google"
 *  - cli=opencode + model "openai/*"            → "openai"
 *  - cli=opencode + model "anthropic/*"         → "anthropic"
 *  - cli=opencode + model "google/*"            → "google"
 *  - cli=opencode + model "moonshotai/*" o "kimi*"  → "moonshot"
 *  - cli=opencode + model "xiaomi/*" o "mimo*"   → "xiaomi"
 *  - cli=opencode + model "deepseek/*"          → "opencode-free" (free tier) — ajustable
 *  - cli=opencode + free token "deepseek-v4-flash-free" → "opencode-free"
 *  - fallback                                   → "unknown"
 *
 * Si el provider no figura en budgets, el Quota Manager lo trata como "sin budget" (available=true).
 */
export function inferProvider(cli: string, model?: string): string {
  switch (cli) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "agy":
      return "google";
    case "opencode":
      return inferOpencodeProvider(model);
    case "hermes":
      // model="provider/modelname" → use provider as billing key.
      // e.g. "openai/gpt-5.5" → "openai", "anthropic/claude-sonnet-4.6" → "anthropic"
      if (!model) return "openai";
      const slash = model.indexOf("/");
      return slash > 0 ? model.slice(0, slash).toLowerCase() : "openai";
    default:
      return "unknown";
  }
}

function inferOpencodeProvider(model?: string): string {
  if (!model) return "unknown";
  const m = model.toLowerCase();
  if (m.includes("free")) return "opencode-free";
  if (m.startsWith("openai/") || m.startsWith("gpt-") || m.includes("gpt-4o")) return "openai";
  if (m.startsWith("anthropic/") || m.includes("claude")) return "anthropic";
  if (m.startsWith("google/") || m.startsWith("gemini")) return "google";
  if (m.startsWith("moonshotai/") || m.includes("kimi")) return "moonshot";
  if (m.startsWith("xiaomi/") || m.includes("mimo")) return "xiaomi";
  if (m.startsWith("deepseek/") || m.includes("deepseek")) return "opencode-free";
  return "unknown";
}

/**
 * Construye candidate list ordenada para `quotaClient.selectModel`:
 *   1. preferredModel
 *   2. ...fallbackChain
 *
 * Cada item resuelve su `provider` automaticamente via `inferProvider`.
 * Si una persona no tiene preferredModel, devuelve [].
 */
export function buildCandidates(
  preferred: ModelPref | undefined,
  fallback: ModelPref[],
): Candidate[] {
  const out: Candidate[] = [];
  if (preferred) {
    out.push({
      cli: preferred.cli,
      model: preferred.model,
      provider: inferProvider(preferred.cli, preferred.model),
    });
  }
  for (const m of fallback) {
    out.push({
      cli: m.cli,
      model: m.model,
      provider: inferProvider(m.cli, m.model),
    });
  }
  // Dedup by (cli, model)
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = `${c.cli}:${c.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
