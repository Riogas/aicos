import { describe, it, expect } from "vitest";
import { evaluate, DEFAULT_RULESET } from "../src/rules.js";
import type { EvaluateInput } from "../src/types.js";

function mkInput(partial: Partial<EvaluateInput>): EvaluateInput {
  return {
    actor: { type: "agent", id: "test-agent" },
    action: "execute-task",
    riskFlags: [],
    ...partial,
  };
}

describe("evaluate (default ruleset)", () => {
  it("allows trivial work with no risk flags", () => {
    const r = evaluate(mkInput({ bucket: "trivial" }), DEFAULT_RULESET);
    expect(r.decision).toBe("allow");
  });

  it("requires approval for critical-feature bucket", () => {
    const r = evaluate(mkInput({ bucket: "critical-feature" }), DEFAULT_RULESET);
    expect(r.decision).toBe("require_approval");
    expect(r.matchedRule?.name).toBe("critical-feature-requires-approval");
  });

  it("requires approval for payments/auth/secrets risk", () => {
    for (const flag of ["payments", "auth", "secrets", "pii"] as const) {
      const r = evaluate(mkInput({ riskFlags: [flag] }), DEFAULT_RULESET);
      expect(r.decision).toBe("require_approval");
      expect(r.reason).toMatch(/sensitive risk/);
    }
  });

  it("denies destructive actions", () => {
    const r = evaluate(mkInput({ riskFlags: ["destructive"] }), DEFAULT_RULESET);
    expect(r.decision).toBe("deny");
    expect(r.matchedRule?.name).toBe("destructive-actions-deny-by-default");
  });

  it("require_approval for high-cost runs", () => {
    const r = evaluate(mkInput({ estimatedCostUsd: 7.5 }), DEFAULT_RULESET);
    expect(r.decision).toBe("require_approval");
    expect(r.matchedRule?.name).toBe("high-cost-runs-require-approval");
  });

  it("approved=true bypasses everything", () => {
    const r = evaluate(
      mkInput({ riskFlags: ["destructive"], approved: true }),
      DEFAULT_RULESET,
    );
    expect(r.decision).toBe("allow");
    expect(r.reason).toMatch(/approved=true/);
  });

  it("deny short-circuits over require_approval", () => {
    // destructive+critical → deny wins
    const r = evaluate(
      mkInput({ riskFlags: ["destructive"], bucket: "critical-feature" }),
      DEFAULT_RULESET,
    );
    expect(r.decision).toBe("deny");
  });
});

describe("evaluate — custom ruleset", () => {
  it("matches actorRegistryIds filter", () => {
    const r = evaluate(
      mkInput({ actor: { type: "agent", id: "x", registryId: "marketing-copywriter" } }),
      {
        version: "test",
        rules: [
          {
            name: "marketing-copy-needs-review",
            effect: "require_approval",
            when: { actorRegistryIds: ["marketing-copywriter"] },
            reason: "all marketing copy goes through review",
          },
        ],
      },
    );
    expect(r.decision).toBe("require_approval");
    expect(r.matchedRule?.name).toBe("marketing-copy-needs-review");
  });

  it("falls back to default allow when no rules match", () => {
    const r = evaluate(mkInput({ bucket: "small-feature" }), {
      version: "test",
      rules: [
        {
          name: "only-critical-needs-approval",
          effect: "require_approval",
          when: { bucket: ["critical-feature"] },
        },
      ],
    });
    expect(r.decision).toBe("allow");
    expect(r.reason).toMatch(/default allow/);
  });

  it("riskFlagsAll requires all flags present", () => {
    const ruleset = {
      version: "test",
      rules: [
        {
          name: "both-auth-and-payments",
          effect: "deny" as const,
          when: { riskFlagsAll: ["auth", "payments"] },
        },
      ],
    };
    expect(
      evaluate(mkInput({ riskFlags: ["auth"] }), ruleset).decision,
    ).toBe("allow"); // partial — no match
    expect(
      evaluate(mkInput({ riskFlags: ["auth", "payments"] }), ruleset).decision,
    ).toBe("deny"); // full match
  });
});
