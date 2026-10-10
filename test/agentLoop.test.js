const assert = require("node:assert/strict");
const { test } = require("node:test");
const { z } = require("zod");
const { runAgentLoop } = require("../out/agentLoop.js");

const json = (value) => JSON.stringify(value);

test("agent loop executes tools iteratively and gives results to the next model turn", async () => {
  const prompts = [];
  const calls = [];
  const result = await runAgentLoop({
    request: "Find and explain the greeting implementation.",
    tools: [{
      name: "search_workspace",
      description: "Search exact text.",
      argumentSchema: z.object({ query: z.string().min(1) }).strict(),
      resultSchema: z.object({ matches: z.array(z.string()) }).strict(),
      async execute(args) {
        calls.push(args.query);
        return { matches: ["src/greeting.ts:4"] };
      },
    }],
    async askModel(prompt) {
      prompts.push(prompt);
      return prompts.length === 1
        ? json({ type: "tool_call", name: "search_workspace", arguments: { query: "hello" } })
        : json({ type: "final", summary: "The greeting is implemented in src/greeting.ts.", notes: "" });
    },
  });

  assert.deepEqual(calls, ["hello"]);
  assert.equal(result.summary, "The greeting is implemented in src/greeting.ts.");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.iterations, 2);
  assert.match(prompts[1], /src\/greeting\.ts:4/);
});

test("agent loop rejects invalid tool arguments before executing the tool", async () => {
  let executions = 0;
  let turn = 0;
  const result = await runAgentLoop({
    request: "Search the workspace.",
    tools: [{
      name: "search_workspace",
      description: "Search exact text.",
      argumentSchema: z.object({ query: z.string().min(1) }).strict(),
      resultSchema: z.array(z.string()),
      async execute() {
        executions += 1;
        return [];
      },
    }],
    async askModel(prompt) {
      turn += 1;
      if (turn === 1) return json({ type: "tool_call", name: "search_workspace", arguments: { query: "" } });
      if (turn === 2) {
        assert.match(prompt, /Tool error in search_workspace arguments/);
        return json({ type: "tool_call", name: "search_workspace", arguments: { query: "TODO" } });
      }
      return json({ type: "final", summary: "Search completed." });
    },
  });

  assert.equal(executions, 1);
  assert.equal(result.toolCalls, 1);
});

test("agent loop accepts and validates legacy change-set responses for API compatibility", async () => {
  const result = await runAgentLoop({
    request: "Add a file.",
    tools: [],
    async askModel() {
      return json({
        summary: "Created the requested file.",
        changes: [{ path: "new.txt", action: "create", content: "hello" }],
      });
    },
  });

  assert.equal(result.changeSet.changes[0].path, "new.txt");
  assert.equal(result.summary, "Created the requested file.");
});

test("agent loop blocks an identical repeatedly failing tool action", async () => {
  let executions = 0;
  let turn = 0;
  const result = await runAgentLoop({
    request: "Try the flaky tool.",
    tools: [{
      name: "flaky",
      description: "Always fails.",
      argumentSchema: z.object({}).strict(),
      resultSchema: z.string(),
      async execute() {
        executions += 1;
        throw new Error("temporary failure");
      },
    }],
    async askModel(prompt) {
      turn += 1;
      if (turn <= 4) {
        if (turn === 4) assert.match(prompt, /failed repeatedly/);
        return json({ type: "tool_call", name: "flaky", arguments: {} });
      }
      return json({ type: "final", summary: "The tool remained unavailable." });
    },
  });

  assert.equal(executions, 2);
  assert.equal(result.toolCalls, 2);
});

