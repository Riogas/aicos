import { describe, it, expect } from "vitest";
import { InMemoryQuotaManager, NoCandidateAvailableError } from "../src/quota-memory.js";
import { budgetsSchema } from "../src/types.js";

function mkBudgets() {
  return budgetsSchema.parse({
    criticalProvider: "anthropic",
    survivalModels: [
      { cli: "opencode", model: "kimi", provider: "moonshot" },
    ],
    providers: {
      anthropic: { windowSec: 60, maxCostUsd: 1.0, maxRequests: 5 },
      moonshot: { windowSec: 60, maxCostUsd: 1.0 },
      "opencode-free": { windowSec: 60, maxRequests: 10 },
    },
    clis: {
      "claude-code": { windowSec: 60, maxRequests: 3 },
    },
  });
}

describe("InMemoryQuotaManager", () => {
  it("records cost and flips availability at the budget threshold", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    expect((await mgr.isProviderAvailable("anthropic")).available).toBe(true);
    await mgr.recordUsage({ provider: "anthropic", costUsd: 0.5, requests: 1 });
    expect((await mgr.isProviderAvailable("anthropic")).available).toBe(true);
    await mgr.recordUsage({ provider: "anthropic", costUsd: 0.5, requests: 1 });
    const a = await mgr.isProviderAvailable("anthropic");
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/over-budget/);
  });

  it("flips at maxRequests too", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    for (let i = 0; i < 5; i++) {
      await mgr.recordUsage({ provider: "anthropic", costUsd: 0.01, requests: 1 });
    }
    const a = await mgr.isProviderAvailable("anthropic");
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/over-requests/);
  });

  it("resets after windowSec expires", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    await mgr.recordUsage({ provider: "anthropic", costUsd: 1.0, requests: 1 });
    expect((await mgr.isProviderAvailable("anthropic")).available).toBe(false);
    now += 61_000;
    expect((await mgr.isProviderAvailable("anthropic")).available).toBe(true);
  });

  it("survival activates when critical provider exhausts", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    expect(await mgr.survivalActive()).toBe(false);
    await mgr.recordUsage({ provider: "anthropic", costUsd: 1.0, requests: 1 });
    expect(await mgr.survivalActive()).toBe(true);
  });

  it("selectModel picks preferred when available", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    const result = await mgr.selectModel({
      candidates: [
        { cli: "claude", model: "claude-opus-4-7", provider: "anthropic" },
        { cli: "opencode", model: "kimi", provider: "moonshot" },
      ],
    });
    expect(result.chosen.provider).toBe("anthropic");
    expect(result.reason).toBe("preferred");
    expect(result.survivalActive).toBe(false);
  });

  it("selectModel skips to fallback when preferred over-budget (non-critical)", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    await mgr.recordUsage({ provider: "moonshot", costUsd: 1.0, requests: 1 });
    const result = await mgr.selectModel({
      candidates: [
        { cli: "opencode", model: "kimi", provider: "moonshot" },
        { cli: "claude", model: "claude-sonnet-4-6", provider: "anthropic" },
      ],
    });
    expect(result.chosen.provider).toBe("anthropic");
    expect(result.reason).toBe("fallback");
    expect(result.survivalActive).toBe(false);
    expect(result.skipped[0]?.reason).toMatch(/over-budget/);
  });

  it("selectModel prepends survival models when critical exhausted", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    await mgr.recordUsage({ provider: "anthropic", costUsd: 1.0, requests: 1 });
    const result = await mgr.selectModel({
      candidates: [
        { cli: "claude", model: "claude-opus-4-7", provider: "anthropic" },
      ],
    });
    expect(result.chosen.provider).toBe("moonshot");
    expect(result.reason).toBe("survival");
    expect(result.survivalActive).toBe(true);
  });

  it("hard rule: no opus for task=trivial", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    const result = await mgr.selectModel({
      task: "trivial",
      candidates: [
        { cli: "claude", model: "claude-opus-4-7", provider: "anthropic" },
        { cli: "opencode", model: "kimi", provider: "moonshot" },
      ],
    });
    expect(result.chosen.model).toBe("kimi");
    expect(result.skipped[0]?.reason).toMatch(/no opus/);
  });

  it("hard rule: no antigravity except large-context", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    const ok = await mgr.selectModel({
      task: "large-context",
      candidates: [{ cli: "antigravity", model: "gemini-3", provider: "google" }],
    });
    expect(ok.chosen.cli).toBe("antigravity");

    await expect(
      mgr.selectModel({
        task: "small-feature",
        candidates: [{ cli: "antigravity", model: "gemini-3", provider: "google" }],
      }),
    ).rejects.toBeInstanceOf(NoCandidateAvailableError);
  });

  it("markProviderDown blocks the provider for cooldownSec", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    await mgr.markProviderDown("anthropic", 120, "rate-limit");
    const a = await mgr.isProviderAvailable("anthropic");
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/rate-limit/);
    now += 121_000;
    expect((await mgr.isProviderAvailable("anthropic")).available).toBe(true);
  });

  it("CLI quota limits independently of provider quota", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    for (let i = 0; i < 3; i++) {
      await mgr.recordUsage({
        provider: "anthropic",
        cli: "claude-code",
        costUsd: 0.01,
        requests: 1,
      });
    }
    const cliAv = await mgr.isCliAvailable("claude-code");
    expect(cliAv.available).toBe(false);
    expect(cliAv.reason).toMatch(/over-requests/);
  });

  it("snapshot returns all configured providers + CLIs", async () => {
    let now = 1_000_000_000_000;
    const mgr = new InMemoryQuotaManager(mkBudgets(), () => now);
    await mgr.recordUsage({ provider: "anthropic", costUsd: 0.3, requests: 1 });
    const s = await mgr.snapshot();
    expect(s.providers.anthropic?.usedCostUsd).toBeCloseTo(0.3);
    expect(s.providers.anthropic?.available).toBe(true);
    expect(s.providers.moonshot?.requests).toBe(0);
    expect(s.clis["claude-code"]?.requests).toBe(0);
    expect(s.criticalProvider).toBe("anthropic");
    expect(s.survivalActive).toBe(false);
  });
});
