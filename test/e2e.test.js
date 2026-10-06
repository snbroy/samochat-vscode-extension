const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { test, beforeEach } = require("node:test");
const { createVscode } = require("./support/vscodeMock");

const state = { root: "", config: {}, infoMessages: [], warnings: [], errors: [], diagnostics: [], confirm: false };
const { vscode } = createVscode(state);
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, ...rest);
};
const { ChatViewProvider } = require("../out/chatViewProvider.js");

let script = [];
let prompts = [];
const apiClient = {
  async sendMessage(message, _history, onEvent) {
    prompts.push(message);
    const next = script.shift();
    assert.ok(next !== undefined, `Unexpected extra API call. Prompt began: ${message.slice(0, 120)}`);
    const answer = typeof next === "function" ? next(message) : next;
    onEvent?.({ type: "token", text: answer });
    onEvent?.({ type: "complete", answer });
    return { answer };
  },
};

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "samo-e2e-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node test.js" } }));
  fs.writeFileSync(path.join(root, "src/cart.js"), "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b);\n");
  fs.writeFileSync(path.join(root, "test.js"), 'const { total } = require("./src/cart");\nconst assert = require("assert");\nassert.equal(total([{ price: 2 }, { price: 3 }]), 5);\n');
  return root;
}

function makeProvider() {
  const store = new Map();
  const context = {
    extensionUri: vscode.Uri.file("/ext"),
    workspaceState: { get: (k, d) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : d), update: async (k, v) => { store.set(k, v); } },
  };
  const provider = new ChatViewProvider(context, apiClient);
  let history = [];
  const posted = [];
  const view = {
    onDidDispose() {},
    webview: {
      options: {},
      html: "",
      asWebviewUri: (u) => u.fsPath,
      cspSource: "x",
      postMessage: (m) => { posted.push(m); if (m.type === "history") history = JSON.parse(JSON.stringify(m.messages)); },
      onDidReceiveMessage: (cb) => { view.send = cb; },
    },
  };
  provider.resolveWebviewView(view);
  return {
    provider,
    view,
    posted,
    ask: async (text) => { await view.send({ type: "sendMessage", text }); return history; },
    last: () => history[history.length - 1],
    get history() { return history; },
  };
}

beforeEach(() => {
  state.root = makeProject();
  state.config = {};
  state.infoMessages = [];
  state.errors = [];
  state.warnings = [];
  state.diagnostics = [];
  state.confirm = false;
  script = [];
  prompts = [];
});

const json = (o) => JSON.stringify(o);

test("normal chat streams an answer, includes the file tree, and edits nothing", async () => {
  const s = makeProvider();
  script = ["Shopify Functions run in WASM."];
  await s.ask("What is a Shopify Function?");
  assert.equal(s.last().text, "Shopify Functions run in WASM.");
  assert.match(prompts[0], /src\/\n\s+cart\.js/);
  assert.equal(s.last().changeSet, undefined);
});

test("develop: plans tasks, creates/edits/deletes files, runs real tests, then Undo restores everything", async () => {
  const s = makeProvider();
  fs.writeFileSync(path.join(state.root, "old.js"), "// obsolete\n");
  script = [
    json({ goal: "Add discount support", analysis: "", tasks: [
      { title: "Add discount helper", details: "", files: ["src/discount.js"] },
      { title: "Use helper in cart and add test", details: "", files: ["src/cart.js", "test.js"] },
    ] }),
    json({ summary: "Added discount helper", plan: [], notes: "", changes: [
      { path: "src/discount.js", action: "create", content: "exports.applyDiscount = (n, pct) => n - n * pct / 100;\n" },
      { path: "old.js", action: "delete" },
    ] }),
    json({ summary: "Wired helper and test", plan: [], notes: "", changes: [
      { path: "src/cart.js", action: "modify", edits: [{ find: "reduce((a, b) => a + b)", replace: "reduce((a, b) => a + b, 0)" }] },
      { path: "test.js", action: "modify", edits: [{ find: "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);", replace: 'assert.equal(total([{ price: 2 }, { price: 3 }]), 5);\nassert.equal(total([]), 0);\nassert.equal(require("./src/discount").applyDiscount(100, 10), 90);' }] },
    ] }),
  ];
  const history = await s.ask("Add discount support to the cart with tests");
  const reply = history[history.length - 1];
  assert.match(reply.text, /3\/\s*3|\(2\/2 complete\)/);
  assert.match(reply.text, /✅ \S?.*Add discount helper/);
  assert.match(reply.text, /Regression tests:\*\* ✅/);
  assert.ok(reply.changeSet && reply.changeSet.status === "applied");
  assert.ok(reply.changeSet.added >= 4 && reply.changeSet.removed >= 2, JSON.stringify(reply.changeSet));
  assert.ok(fs.existsSync(path.join(state.root, "src/discount.js")));
  assert.equal(fs.existsSync(path.join(state.root, "old.js")), false);
  assert.match(fs.readFileSync(path.join(state.root, "src/cart.js"), "utf8"), /, 0\)/);

  await s.view.send({ type: "undoChangeSet", id: reply.changeSet.id });
  assert.equal(s.last().changeSet.status, "undone");
  assert.equal(fs.existsSync(path.join(state.root, "src/discount.js")), false);
  assert.equal(fs.readFileSync(path.join(state.root, "old.js"), "utf8"), "// obsolete\n");
  assert.doesNotMatch(fs.readFileSync(path.join(state.root, "src/cart.js"), "utf8"), /, 0\)/);
});

test("debug: pasted stack trace targets the right file and failing tests trigger an automatic fix", async () => {
  const s = makeProvider();
  fs.writeFileSync(path.join(state.root, "test.js"), 'const { total } = require("./src/cart");\nconst assert = require("assert");\nassert.equal(total([]), 0);\n');
  const trace = `TypeError: Reduce of empty array with no initial value\n    at Array.reduce (<anonymous>)\n    at total (/Users/me/demo/src/cart.js:1:60)\n    at Object.<anonymous> (/Users/me/demo/test.js:3:14)`;
  script = [
    json({ goal: "Fix empty-cart crash", analysis: "reduce has no initial value", tasks: [{ title: "Fix reduce in cart.js", details: "", files: ["src/cart.js"] }] }),
    (msg) => { assert.match(msg, /src\/cart\.js:1/); return json({ summary: "Attempted fix", plan: [], notes: "", changes: [{ path: "src/cart.js", action: "modify", content: "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 1);\n" }] }); },
    (msg) => { assert.match(msg, /tests failed/i); return json({ summary: "Corrected initial value", plan: [], notes: "", changes: [{ path: "src/cart.js", action: "modify", content: "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 0);\n" }] }); },
  ];
  await s.ask(trace);
  assert.match(s.last().text, /passed after 1 automatic fix attempt/);
  assert.match(fs.readFileSync(path.join(state.root, "src/cart.js"), "utf8"), /b, 0\)/);
});

test("safety: a change set that escapes the workspace is rejected and nothing is written", async () => {
  const s = makeProvider();
  const outside = path.join(path.dirname(state.root), "pwned.txt");
  const bad = json({ summary: "x", plan: [], notes: "", changes: [{ path: "../pwned.txt", action: "create", content: "x" }] });
  script = [
    json({ goal: "g", analysis: "", tasks: [{ title: "Write file", details: "", files: [] }] }),
    bad, bad,
  ];
  await s.ask("Create a new component file");
  assert.equal(fs.existsSync(outside), false);
  assert.doesNotMatch(s.last().text || "", /changeSet/);
  assert.equal(s.last().changeSet, undefined);
});

test("understand: reads files line by line and sends numbered source", async () => {
  const s = makeProvider();
  script = [(msg) => { assert.match(msg, /### src\/cart\.js\n1\| exports\.total/); return "## Overview\nA tiny cart."; }];
  await s.ask("Understand this project");
  assert.match(s.last().text, /A tiny cart\./);
  assert.match(s.last().text, /Read \d+ files/);
});

test("understand a named folder only reads that folder", async () => {
  const s = makeProvider();
  script = [(msg) => { assert.match(msg, /### src\/cart\.js/); assert.doesNotMatch(msg, /### test\.js/); return "Folder report"; }];
  await s.ask("Understand the src folder and explain the app");
  assert.match(s.last().text, /Folder report/);
});

test("audit: includes diagnostics and test output, and recovers from a leaked tool call", async () => {
  const s = makeProvider();
  fs.writeFileSync(path.join(state.root, "test.js"), "process.exit(1);\n");
  state.diagnostics = [[vscode.Uri.file(path.join(state.root, "src/cart.js")), [{ severity: 0, range: { start: { line: 0 } }, message: "Unexpected token", source: "ts" }]]];
  const leak = "<tool_call> <function=search_shopify_docs> <parameter=query> esbuild </parameter> </function> </tool_call>";
  script = [
    leak,
    (msg) => { assert.match(msg, /ERROR src\/cart\.js:1 Unexpected token/); assert.match(msg, /npm test: FAILED/); return "| High | src/cart.js:1 | Unexpected token | fix |"; },
  ];
  await s.ask("check my project and see if there any issue or error");
  assert.match(s.last().text, /Unexpected token/);
  assert.doesNotMatch(s.last().text, /tool_call/);
});

test("chat: a leaked tool call is retried instead of being shown", async () => {
  const s = makeProvider();
  script = ["<tool_call><function=x></function></tool_call>", "Real answer."];
  await s.ask("What is Liquid?");
  assert.equal(s.last().text, "Real answer.");
});

test("review and PR: review reads the git diff; PR is cancellable and reports push failure", async () => {
  const s = makeProvider();
  execFileSync("git", ["init", "-q"], { cwd: state.root });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "add", "-A"], { cwd: state.root });
  execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: state.root });
  fs.appendFileSync(path.join(state.root, "src/cart.js"), "// change\n");
  script = [(msg) => { assert.match(msg, /\+\/\/ change/); return json({ review: "Looks fine.", summary: "No revisions", plan: [], notes: "", changes: [] }); }];
  await s.ask("review my changes");
  assert.match(s.last().text, /Looks fine\./);

  await s.ask("create a pull request");
  assert.match(s.last().text, /cancelled/);

  state.confirm = true;
  await s.ask("create a pull request");
  assert.match(s.last().text, /❌/);
  assert.match(s.last().text, /push failed|origin/i);
});

test("no workspace folder gives a clear error, and normal chat keeps working", async () => {
  const s = makeProvider();
  const original = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  Object.defineProperty(vscode.workspace, "workspaceFolders", { get: () => undefined, configurable: true });
  vscode.workspace.getWorkspaceFolder = () => undefined;
  await s.ask("Add a wishlist feature to the app");
  assert.match(s.last().text, /Open a folder/);
  Object.defineProperty(vscode.workspace, "workspaceFolders", original);
  vscode.workspace.getWorkspaceFolder = () => ({ uri: vscode.Uri.file(state.root) });
});

test("editor selection is reported to the webview and sent to the model with its line range", async () => {
  const s = makeProvider();
  const file = path.join(state.root, "src/cart.js");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const doc = { uri: vscode.Uri.file(file), fileName: file, languageId: "javascript", isClosed: false, getText: (range) => (range ? lines.slice(range.start.line, range.end.line + 1).join("\n") : text) };
  const editor = { document: doc, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 1, character: 4 } } };
  vscode.window.activeTextEditor = editor;
  state.selectionListener({ textEditor: editor });
  const ctx = s.posted.filter((m) => m.type === "editorContext").pop().context;
  assert.equal(ctx.name, "cart.js");
  assert.equal(ctx.hasSelection, true);
  assert.deepEqual([ctx.startLine, ctx.endLine], [1, 2]);

  script = ["ok"];
  await s.view.send({ type: "sendMessage", text: "Explain this", includeEditorContext: true });
  const sent = JSON.stringify(prompts[prompts.length - 1]);
  assert.match(sent, /"scope\\":\\"selection\\"/);
  assert.match(sent, /startLine\\":1,\\"endLine\\":2/);
  vscode.window.activeTextEditor = undefined;
});
