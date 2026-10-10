const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");
const { createVscode } = require("./support/vscodeMock");

const state = { root: "", config: {}, infoMessages: [], warnings: [], errors: [], diagnostics: [] };
const { vscode } = createVscode(state);
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, ...rest);
};
const { McpClientManager, parseMcpServerConfigs } = require("../out/mcpClient.js");
Module._load = originalLoad;

const serverConfig = { name: "test-server", command: "mcp-test", args: ["--stdio"], env: {} };
const tool = { name: "echo", description: "Return the supplied value", inputSchema: { type: "object" } };

function createManager({ allowLaunch = true, allowTool = true, trusted = true, serverTool = tool } = {}) {
  vscode.workspace.isTrusted = trusted;
  let launchPrompts = 0;
  let toolPrompts = 0;
  let calls = 0;
  let closes = 0;
  const client = {
    async listTools() { return { tools: [serverTool] }; },
    async callTool() {
      calls += 1;
      return { content: [{ type: "text", text: "done" }] };
    },
    async close() { closes += 1; },
  };
  const manager = new McpClientManager(
    () => [serverConfig],
    async () => client,
    async () => { launchPrompts += 1; return allowLaunch; },
    async () => { toolPrompts += 1; return allowTool; },
  );
  return {
    manager,
    counts: () => ({ launchPrompts, toolPrompts, calls, closes }),
  };
}

test("MCP configuration parsing rejects unsafe shapes and bounds server definitions", () => {
  const configs = parseMcpServerConfigs([
    { name: "good", command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
    { name: "good", command: "other" },
    { name: "../bad", command: "node" },
    { name: "bad", command: "node", args: [4] },
    { name: "bad-env", command: "node", env: { "bad-key": "ignored" } },
    ...Array.from({ length: 20 }, (_, index) => ({ name: `server-${index}`, command: "node" })),
  ]);

  assert.equal(configs.length, 12);
  assert.equal(configs[0].name, "good");
  assert.deepEqual(configs[0].env, { TOKEN: "secret" });
  assert.deepEqual(parseMcpServerConfigs({ name: "not-an-array" }), []);
});

test("MCP tool arguments are validated against the server input schema before approval", async () => {
  const serverTool = {
    ...tool,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  const { manager, counts } = createManager({ serverTool });

  await assert.rejects(manager.callTool("test-server", "echo", {}), /do not match its input schema/);
  assert.equal(counts().toolPrompts, 0);
  assert.equal(counts().calls, 0);
  await manager.dispose();
});

test("MCP tool execution requires server launch and per-call approval", async () => {
  const { manager, counts } = createManager();
  const first = await manager.callTool("test-server", "echo", { value: "hello" });
  const second = await manager.callTool("test-server", "echo", { value: "again" });

  assert.equal(first.content[0].text, "done");
  assert.equal(second.content[0].text, "done");
  assert.deepEqual(counts(), { launchPrompts: 1, toolPrompts: 2, calls: 2, closes: 0 });
  await manager.dispose();
  assert.equal(counts().closes, 1);
});

test("MCP tool is not invoked when per-call approval is denied", async () => {
  const { manager, counts } = createManager({ allowTool: false });
  await assert.rejects(manager.callTool("test-server", "echo", {}), /was not approved/);
  assert.equal(counts().calls, 0);
  assert.equal(counts().toolPrompts, 1);
  await manager.dispose();
});

test("MCP server is not launched without explicit launch approval", async () => {
  const { manager, counts } = createManager({ allowLaunch: false });
  await assert.rejects(manager.listTools(), /was not started/);
  assert.equal(counts().launchPrompts, 1);
  assert.equal(counts().calls, 0);
});

test("MCP tools are disabled in an untrusted workspace", async () => {
  const { manager, counts } = createManager({ trusted: false });
  await assert.rejects(manager.listTools(), /workspace is trusted/);
  assert.deepEqual(counts(), { launchPrompts: 0, toolPrompts: 0, calls: 0, closes: 0 });
});

test("concurrent MCP requests share one launch approval and one connection", async () => {
  vscode.workspace.isTrusted = true;
  let launchPrompts = 0;
  let connects = 0;
  const client = {
    async listTools() { return { tools: [tool] }; },
    async callTool() { return { content: [] }; },
    async close() {},
  };
  const manager = new McpClientManager(
    () => [serverConfig],
    async () => { connects += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return client; },
    async () => { launchPrompts += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return true; },
    async () => true,
  );

  const [first, second] = await Promise.all([manager.listTools(), manager.listTools()]);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(launchPrompts, 1);
  assert.equal(connects, 1);
  await manager.dispose();
});

test("MCP result sizes are bounded and disposed managers reject further connections", async () => {
  vscode.workspace.isTrusted = true;
  const client = {
    async listTools() { return { tools: [tool] }; },
    async callTool() { return { content: [{ type: "text", text: "x".repeat(65_000) }] }; },
    async close() {},
  };
  const manager = new McpClientManager(() => [serverConfig], async () => client, async () => true, async () => true);
  await assert.rejects(manager.callTool("test-server", "echo", {}), /more than 64000 bytes/);
  await manager.dispose();
  await assert.rejects(manager.listTools(), /disposed/);
});
