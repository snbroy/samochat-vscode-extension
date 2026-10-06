const assert = require("node:assert/strict");
const { test } = require("node:test");
const core = require("../out/agentCore.js");

test("detectIntent routes requests", () => {
  assert.equal(core.detectIntent("What is this Shopify Function doing?"), "chat");
  assert.equal(core.detectIntent("How do I add a wishlist?"), "chat");
  assert.equal(core.detectIntent("Understand this project"), "understand");
  assert.equal(core.detectIntent("read the src/api folder and explain the app"), "understand");
  assert.equal(core.detectIntent("Add wishlist functionality to my app"), "develop");
  assert.equal(core.detectIntent("fix the bug in this file"), "develop");
  assert.equal(core.detectIntent("create a pull request"), "pr");
  assert.equal(core.detectIntent("review my changes"), "review");
  assert.equal(core.detectIntent("hello there"), "chat");
});

test("validateRelativePath blocks escapes and protected paths", () => {
  assert.equal(core.validateRelativePath("src/a.ts").ok, true);
  for (const bad of ["../x", "/etc/passwd", "C:\\x", "a/../../x", "~/x", ".git/config", ".env", "node_modules/a/b.js", "", "src/", "a\0b"]) {
    assert.equal(core.validateRelativePath(bad).ok, false, bad);
  }
  assert.equal(core.resolveInside("/ws", "../x"), undefined);
  assert.equal(core.resolveInside("/ws", "a/b.ts"), "/ws/a/b.ts");
});

test("parseChangeSet reads JSON from fences and validates", () => {
  const ok = core.parseChangeSet('Here:\n```json\n{"summary":"s","changes":[{"path":"a.ts","action":"create","content":"x"},{"path":"b.ts","action":"delete"},{"path":"c.ts","action":"modify","edits":[{"find":"a","replace":"b"}]}]}\n```');
  assert.equal(ok.ok, true);
  assert.equal(ok.value.changes.length, 3);
  assert.equal(core.parseChangeSet("no json").ok, false);
  assert.equal(core.parseChangeSet('{"changes":[{"path":"../x","action":"create","content":"1"}]}').ok, false);
  assert.equal(core.parseChangeSet('{"changes":[{"path":"a","action":"create"}]}').ok, false);
  assert.equal(core.parseChangeSet('{"changes":[{"path":"a","action":"create","content":""},{"path":"a","action":"delete"}]}').ok, false);
});

test("applyTextEdits requires a unique match", () => {
  assert.equal(core.applyTextEdits("a b c", [{ find: "b", replace: "X" }]), "a X c");
  assert.throws(() => core.applyTextEdits("a a", [{ find: "a", replace: "b" }]));
  assert.throws(() => core.applyTextEdits("a", [{ find: "z", replace: "b" }]));
});

test("tree, mentions, test command detection", () => {
  const files = ["src/api/a.ts", "src/ui/Button.tsx", "package.json"];
  assert.match(core.formatFileTree(files), /src\/\n {2}api\/\n {4}a\.ts/);
  const m = core.findMentionedPaths("understand src/api and Button.tsx", files);
  assert.deepEqual(m.folders, ["src/api"]);
  assert.deepEqual(m.files, ["src/ui/Button.tsx"]);
  assert.equal(core.detectTestCommand(new Set(["package.json"]), '{"scripts":{"test":"node --test"}}').label, "npm test");
  assert.equal(core.detectTestCommand(new Set(["package.json"]), '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}'), undefined);
  assert.equal(core.isIgnoredPath("node_modules/x/y.js"), true);
});

test("error reports are routed to debug and mapped to workspace files", () => {
  const log = "TypeError: Cannot read properties of undefined (reading 'id')\n    at getCart (/Users/me/app/src/services/cart.ts:42:17)\n    at handler (/Users/me/app/src/routes/api.ts:10:5)";
  assert.equal(core.detectIntent(log), "debug");
  assert.equal(core.detectIntent("I'm getting this error: Cannot find module 'zod'"), "debug");
  assert.equal(core.detectIntent("What does a TypeError mean?"), "chat");
  const files = ["src/services/cart.ts", "src/routes/api.ts", "README.md"];
  assert.deepEqual(core.extractErrorFiles(log, files), [
    { file: "src/services/cart.ts", line: 42 },
    { file: "src/routes/api.ts", line: 10 },
  ]);
});

test("parsePlan validates tasks and renderTaskBoard shows progress", () => {
  const plan = core.parsePlan('{"goal":"g","tasks":[{"title":"A","files":["src/a.ts","../x"]},{"nope":1},{"title":"B"}]}');
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[0].files, ["src/a.ts"]);
  assert.equal(core.parsePlan("{}"), undefined);
  const board = core.renderTaskBoard(plan, [{ title: "A", state: "done" }, { title: "B", state: "running" }]);
  assert.match(board, /\(1\/2 complete\)/);
  assert.match(board, /1\. ✅ A/);
});

test("project audit requests are detected; leaked tool calls are caught", () => {
  assert.equal(core.detectIntent("check my project and see if there any issue or error"), "audit");
  assert.equal(core.detectIntent("scan the codebase for bugs"), "audit");
  assert.equal(core.detectIntent("are there any errors in src/api folder?"), "audit");
  assert.equal(core.detectIntent("fix these issues"), "develop");
  assert.equal(core.detectIntent("review my changes"), "review");
  assert.equal(core.detectIntent("Add wishlist functionality"), "develop");
  const leak = "<tool_call> <function=search_shopify_docs> <parameter=query> esbuild </parameter> </function> </tool_call>";
  assert.equal(core.hasLeakedToolCall(leak), true);
  assert.equal(core.stripLeakedToolCalls(`ok ${leak}`), "ok");
  assert.equal(core.hasLeakedToolCall("normal answer"), false);
});
