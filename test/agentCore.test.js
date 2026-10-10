const assert = require("node:assert/strict");
const { test } = require("node:test");
const core = require("../out/agentCore.js");

test("detectIntent routes requests", () => {
  assert.equal(core.detectIntent("What is this Shopify Function doing?"), "chat");
  assert.equal(core.detectIntent("How do I add a wishlist?"), "chat");
  assert.equal(core.detectIntent("Understand this project"), "understand");
  assert.equal(core.detectIntent("read the src/api folder and explain the app"), "understand");
  assert.equal(core.detectIntent("Add wishlist functionality to my app"), "develop");
  assert.equal(core.detectIntent("make my footer beautiful and great design"), "develop");
  assert.equal(core.detectIntent("redesign the navbar to work better on mobile"), "develop");
  assert.equal(core.detectIntent("what makes a good footer design?"), "chat");
  assert.equal(core.detectIntent("fix the bug in this file"), "develop");
  assert.equal(core.detectIntent("create a pull request"), "pr");
  assert.equal(core.detectIntent("review my changes"), "review");
  assert.equal(core.detectIntent("hello there"), "chat");
});

test("casual greetings get a quick response without requiring project context", () => {
  assert.equal(core.quickReplyFor("hi"), "Hi! What can I help you with?");
  assert.equal(core.quickReplyFor("Good morning!"), "Good day! What can I help you with?");
  assert.equal(core.quickReplyFor("How are you?"), "Doing well—ready to help! What's on your mind?");
  assert.equal(core.quickReplyFor("Hi, can you fix my code?"), undefined);
  assert.equal(core.shouldUseConversationHistory("hi"), false);
  assert.equal(core.shouldUseConversationHistory("What is a closure in JavaScript?"), false);
  assert.equal(core.shouldUseConversationHistory("Why?"), true);
  assert.equal(core.shouldUseConversationHistory("Can you make that responsive?"), true);
  assert.equal(core.shouldIncludeWorkspaceTree("hi"), false);
  assert.equal(core.shouldIncludeWorkspaceTree("What files are in my project?"), true);
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

test("write safeguards identify protected paths, lockfiles, and hash existing text", () => {
  assert.equal(core.isProtectedWritePath("nested/.env.local"), true);
  assert.equal(core.isProtectedWritePath("node_modules/pkg/index.js"), true);
  assert.equal(core.isProtectedWritePath("Node_Modules/pkg/index.js"), true);
  assert.equal(core.isProtectedWritePath(".git/config"), true);
  assert.equal(core.isProtectedWritePath(".GIT/config"), true);
  assert.equal(core.isProtectedWritePath("src/config.ts"), false);
  assert.equal(core.isPackageManagerManagedFile("nested/package-lock.json"), true);
  assert.equal(core.isPackageManagerManagedFile("src/package.json"), false);
  assert.equal(core.sha256Text("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
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

test("regression plan includes available tests, typecheck, lint and build scripts", () => {
  const files = new Set(["package.json", "pnpm-lock.yaml"]);
  const plan = core.buildRegressionPlan(files, JSON.stringify({
    scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint .", build: "vite build" },
  }));
  assert.deepEqual(plan.map(({ label, command, args }) => ({ label, command, args })), [
    { label: "Automated tests (pnpm test)", command: "pnpm", args: ["test"] },
    { label: "Typecheck", command: "pnpm", args: ["run", "typecheck"] },
    { label: "Lint", command: "pnpm", args: ["run", "lint"] },
    { label: "Build", command: "pnpm", args: ["run", "build"] },
  ]);
});

test("error reports are routed to debug and mapped to workspace files", () => {
  const log = "TypeError: Cannot read properties of undefined (reading 'id')\n    at getCart (/Users/me/app/src/services/cart.ts:42:17)\n    at handler (/Users/me/app/src/routes/api.ts:10:5)";
  assert.equal(core.detectIntent(log), "debug");
  assert.equal(core.detectIntent("I'm getting this error: Cannot find module 'zod'"), "debug");
  assert.equal(core.detectIntent("fixed the error for the selected code"), "debug");
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
  assert.equal(core.isAuditAndFixRequest("Analyze my current project and fix any issues"), true);
  assert.equal(core.isAuditAndFixRequest("Analyze my current project for issues"), false);
  assert.equal(core.detectIntent("fix these issues"), "develop");
  assert.equal(core.detectIntent("review my changes"), "review");
  assert.equal(core.detectIntent("Add wishlist functionality"), "develop");
  const leak = "<tool_call> <function=search_shopify_docs> <parameter=query> esbuild </parameter> </function> </tool_call>";
  assert.equal(core.hasLeakedToolCall(leak), true);
  assert.equal(core.stripLeakedToolCalls(`ok ${leak}`), "ok");
  assert.equal(core.hasLeakedToolCall("normal answer"), false);
});

test("agent budgets stay within safety ceilings and count unique changed files", () => {
  const oversizedBudget = {
    ...core.defaultAgentBudget,
    maxIterations: core.maxAgentIterations + 10,
    maxToolCalls: core.maxToolCalls + 10,
    maxChangedFiles: core.maxChangedFiles + 10,
  };
  const run = core.createAgentRun("Implement a feature", "develop", oversizedBudget);
  assert.match(run.id, /^[0-9a-z]+-[0-9a-f-]{8}$/);
  assert.equal(run.maxIterations, core.maxAgentIterations);
  assert.equal(core.canContinue({ ...run, iteration: core.maxAgentIterations }, oversizedBudget).ok, false);
  assert.equal(core.canContinue({ ...run, toolCalls: core.maxToolCalls }, oversizedBudget).ok, false);
  assert.equal(core.canContinue({
    ...run,
    changedFiles: Array.from({ length: core.maxChangedFiles + 1 }, (_, index) => `src/${index}.ts`),
  }, oversizedBudget).ok, false);
  assert.equal(core.canContinue({ ...run, changedFiles: ["src/a.ts", "src/a.ts"] }, oversizedBudget).ok, true);
});

test("context selection prioritizes relevant source and excludes generated files", () => {
  const files = [
    { path: "package.json", size: 10 },
    { path: "src/payment.ts", size: 20 },
    { path: "dist/payment.js", size: 20 },
    { path: "src/generated.ts", size: 20, generated: true },
  ];
  const context = core.selectContext("update payment handling", files, new Map([
    ["package.json", "{}"],
    ["src/payment.ts", "payment source"],
    ["dist/payment.js", "generated build"],
    ["src/generated.ts", "generated source"],
  ]), 100);
  assert.equal(context.items[0].path, "src/payment.ts");
  assert.deepEqual(context.items.map((item) => item.path), ["src/payment.ts", "package.json"]);
});

test("text diff summary counts repeated lines correctly", () => {
  assert.deepEqual(core.summarizeTextDiff("same\nsame", "same\nnew"), {
    files: [],
    additions: 1,
    deletions: 1,
  });
});
