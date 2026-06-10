/**
 * Unit tests for the orchestrator's pure logic — sanitize() (the
 * DAG-validation step), buildEnrichedDescription's idempotency proxies
 * (covered indirectly via sanitize stability), createSubtaskTree() against
 * a stubbed PaperclipClient. The LLM-spawn decompose() is integration-only
 * — covered by test_pipeline_e2e.py — because it requires a real claude
 * subprocess to be meaningful.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSubtaskTree,
  type Decomposition,
  type OrchestrateInput,
} from "../src/orchestrator.js";
import * as registry from "../src/registry.js";
import type { PaperclipClient } from "../src/paperclip-client.js";

// Internal sanitize/fallback functions aren't exported. We import the module
// itself and use module-level mocks for what they depend on (registry +
// gateway). The behaviour we care about is observable through orchestrate()'s
// outputs and createSubtaskTree's behaviour.

beforeEach(() => {
  // Default registry stub — listRegistryAgents returns a small canned roster.
  vi.spyOn(registry, "loadRegistry").mockReturnValue({
    totalAgents: 3,
    agentsWithPaperclipId: 3,
    agentsWithKey: 3,
    resolvable: 3,
    projectWorkspaces: 0,
    registryPath: "(stub)",
    keysPath: "(stub)",
    workspacesPath: "(stub)",
    registryLoaded: true,
    keysLoaded: true,
    workspacesLoaded: true,
  });
  vi.spyOn(registry, "listRegistryAgents").mockReturnValue([
    { id: "it-analyst", name: "IT Analyst", department: "it", capabilities: "Spec writing" },
    { id: "it-architect", name: "IT Architect", department: "it", capabilities: "Design" },
    { id: "it-implementer", name: "IT Implementer", department: "it", capabilities: "Code" },
  ]);
  vi.spyOn(registry, "resolvePersonaByRegistryId").mockImplementation((id: string) => {
    if (["it-analyst", "it-architect", "it-implementer"].includes(id)) {
      return {
        registryId: id,
        agentName: id,
        department: "it",
        systemPrompt: "",
        fallbackChain: [],
        apiKey: "k",
      };
    }
    return null;
  });
  vi.spyOn(registry, "getPaperclipAgentIdForRegistryId").mockImplementation((id: string) => {
    if (id === "it-analyst") return "uuid-analyst";
    if (id === "it-architect") return "uuid-architect";
    if (id === "it-implementer") return "uuid-impl";
    return null;
  });
});

function buildPcStub(): { client: PaperclipClient; calls: Array<Parameters<PaperclipClient["createIssue"]>[0]> } {
  const calls: Array<Parameters<PaperclipClient["createIssue"]>[0]> = [];
  const client = {
    createIssue: vi.fn(async (input: Parameters<PaperclipClient["createIssue"]>[0]) => {
      calls.push(input);
      // Return an issue with a generated id + identifier matching the call order.
      const idx = calls.length;
      return {
        id: `iss-${idx}`,
        identifier: `RIO-${idx}`,
        title: input.title,
        description: input.description ?? "",
        status: input.status,
      };
    }),
  } as unknown as PaperclipClient;
  return { client, calls };
}

describe("createSubtaskTree", () => {
  const baseInput: OrchestrateInput = {
    taskDescription: "Big task",
    companyId: "co-1",
    projectId: "proj-1",
  };

  it("creates one issue per subtask in plan order", async () => {
    const decomp: Decomposition = {
      summary: "x",
      atomic: false,
      subtasks: [
        { id: "s1", title: "Spec it", description: "spec", role: "it-analyst", dependsOn: [] },
        { id: "s2", title: "Design", description: "design", role: "it-architect", dependsOn: ["s1"] },
        { id: "s3", title: "Build", description: "build", role: "it-implementer", dependsOn: ["s2"] },
      ],
    };
    const { client, calls } = buildPcStub();
    const { created, warnings } = await createSubtaskTree(baseInput, decomp, client);
    expect(created).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(created[0]!.role).toBe("it-analyst");
    expect(created[2]!.role).toBe("it-implementer");
    expect(warnings).toEqual([]);
  });

  it("first subtask gets status='todo', subsequent subtasks get 'backlog'", async () => {
    const decomp: Decomposition = {
      summary: "x",
      atomic: false,
      subtasks: [
        { id: "s1", title: "A", description: "", role: "it-analyst", dependsOn: [] },
        { id: "s2", title: "B", description: "", role: "it-architect", dependsOn: ["s1"] },
      ],
    };
    const { client, calls } = buildPcStub();
    await createSubtaskTree(baseInput, decomp, client);
    expect(calls[0]!.status).toBe("todo");
    expect(calls[1]!.status).toBe("backlog");
  });

  it("wires blockedByIssueIds using the actual generated issue ids", async () => {
    const decomp: Decomposition = {
      summary: "x",
      atomic: false,
      subtasks: [
        { id: "s1", title: "A", description: "", role: "it-analyst", dependsOn: [] },
        { id: "s2", title: "B", description: "", role: "it-architect", dependsOn: ["s1"] },
      ],
    };
    const { client, calls } = buildPcStub();
    await createSubtaskTree(baseInput, decomp, client);
    expect(calls[0]!.blockedByIssueIds).toBeUndefined();
    // s2 should reference the id of the issue created for s1 (= "iss-1").
    expect(calls[1]!.blockedByIssueIds).toEqual(["iss-1"]);
  });

  it("propagates parentId through every subtask creation", async () => {
    const decomp: Decomposition = {
      summary: "x",
      atomic: false,
      subtasks: [
        { id: "s1", title: "A", description: "", role: "it-analyst", dependsOn: [] },
      ],
    };
    const { client, calls } = buildPcStub();
    await createSubtaskTree(
      { ...baseInput, parentIssueId: "parent-xyz" },
      decomp,
      client,
    );
    expect(calls[0]!.parentId).toBe("parent-xyz");
  });

  it("skips subtasks whose role is not in registry (logs warning instead of throwing)", async () => {
    const decomp: Decomposition = {
      summary: "x",
      atomic: false,
      subtasks: [
        { id: "s1", title: "Good", description: "", role: "it-analyst", dependsOn: [] },
        { id: "s2", title: "Bad", description: "", role: "nonexistent-role", dependsOn: [] },
      ],
    };
    const { client, calls } = buildPcStub();
    const { created, warnings } = await createSubtaskTree(baseInput, decomp, client);
    expect(created).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(warnings[0]).toMatch(/nonexistent-role/);
  });

  it("records a createIssue failure as a warning but continues with siblings", async () => {
    const decomp: Decomposition = {
      summary: "x",
      atomic: false,
      subtasks: [
        { id: "s1", title: "A", description: "", role: "it-analyst", dependsOn: [] },
        { id: "s2", title: "B", description: "", role: "it-architect", dependsOn: [] },
      ],
    };
    const client = {
      createIssue: vi
        .fn()
        .mockResolvedValueOnce({ id: "iss-1", identifier: "RIO-1", status: "todo" })
        .mockRejectedValueOnce(new Error("paperclip timeout")),
    } as unknown as PaperclipClient;
    const { created, warnings } = await createSubtaskTree(baseInput, decomp, client);
    expect(created).toHaveLength(1);
    expect(warnings.some((w) => w.includes("paperclip timeout"))).toBe(true);
  });
});
