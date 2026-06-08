import { describe, it, expect } from "vitest";

// Re-import private parsers via the module — TypeScript prevents direct import
// of non-exported fns. We use a small workaround: import the module and call
// the public invokeCli is overkill. Instead we inline-test the parsing logic
// by validating known fixture payloads through the exported `parseOutput` if
// available, or by replicating the algorithm in the test (the parsers are
// pure functions of stdout strings).
//
// To keep this test simple AND maintainable, the test imports the parsers
// directly. They were re-exported from cli-direct.ts for testing.
import {
  __testHooks,
} from "../src/cli-direct.js";

const { parseClaudeJson, parseCodexJsonl, parseOpencodeNdjson } = __testHooks;

describe("parseClaudeJson", () => {
  it("extracts result + cost + tokens from claude --output-format json", () => {
    const sample = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Hello, world!",
      total_cost_usd: 0.0342,
      duration_ms: 1234,
      usage: {
        input_tokens: 500,
        output_tokens: 120,
        cache_read_input_tokens: 200,
      },
    });
    const r = parseClaudeJson(sample);
    expect(r.parsedText).toBe("Hello, world!");
    expect(r.costUsd).toBeCloseTo(0.0342);
    expect(r.tokens?.input).toBe(500);
    expect(r.tokens?.output).toBe(120);
    expect(r.tokens?.cached).toBe(200);
  });

  it("tolerates leading log lines before the JSON", () => {
    const sample = `Some prelude log line\nAnother line\n${JSON.stringify({
      result: "OK",
      total_cost_usd: 0.001,
    })}`;
    const r = parseClaudeJson(sample);
    expect(r.parsedText).toBe("OK");
    expect(r.costUsd).toBeCloseTo(0.001);
  });
});

describe("parseCodexJsonl", () => {
  it("extracts last agent_message text + accumulated tokens", () => {
    const lines = [
      JSON.stringify({ type: "session_start" }),
      JSON.stringify({ msg: { type: "agent_message", message: "first reply" } }),
      JSON.stringify({ msg: { type: "token_count", input_tokens: 100, output_tokens: 50 } }),
      JSON.stringify({ msg: { type: "agent_message", message: "final answer here" } }),
      JSON.stringify({ msg: { type: "token_count", input_tokens: 50, output_tokens: 20 } }),
    ].join("\n");
    const r = parseCodexJsonl(lines);
    expect(r.parsedText).toBe("final answer here");
    expect(r.tokens?.input).toBe(150);
    expect(r.tokens?.output).toBe(70);
    expect(r.costUsd).toBeUndefined();
  });

  it("ignores malformed lines", () => {
    const lines = [
      "not json at all",
      JSON.stringify({ msg: { type: "agent_message", message: "ok" } }),
    ].join("\n");
    const r = parseCodexJsonl(lines);
    expect(r.parsedText).toBe("ok");
  });
});

describe("parseOpencodeNdjson", () => {
  it("sums cost across step_finish events + collects text", () => {
    const lines = [
      JSON.stringify({ type: "text", text: "Hello " }),
      JSON.stringify({ type: "step_finish", part: { cost: 0.0008, tokens: { input: 200, output: 50 } } }),
      JSON.stringify({ type: "text", text: "world" }),
      JSON.stringify({ type: "step_finish", part: { cost: 0.0002, tokens: { input: 80, output: 20 } } }),
    ].join("\n");
    const r = parseOpencodeNdjson(lines);
    expect(r.parsedText).toBe("Hello world");
    expect(r.costUsd).toBeCloseTo(0.001);
    expect(r.tokens?.input).toBe(280);
    expect(r.tokens?.output).toBe(70);
  });

  it("returns undefined cost when no step_finish events present", () => {
    const lines = [
      JSON.stringify({ type: "text", text: "just text" }),
    ].join("\n");
    const r = parseOpencodeNdjson(lines);
    expect(r.parsedText).toBe("just text");
    expect(r.costUsd).toBeUndefined();
  });
});
