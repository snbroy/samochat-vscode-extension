const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { test, beforeEach } = require("node:test");
const { createVscode } = require("./support/vscodeMock");
const { sha256Text } = require("../out/agentCore.js");

const state = { root: "", config: {}, infoMessages: [], warnings: [], errors: [], diagnostics: [], confirm: false };
const { vscode } = createVscode(state);
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, ...rest);
};
const { ChatViewProvider } = require("../out/chatViewProvider.js");

let script = [];
let prompts = [];
let sentHistories = [];
const apiClient = {
  async sendMessage(message, history, onEvent, _mode, signal) {
    prompts.push(message);
    sentHistories.push(history);
    const next = script.shift();
    assert.ok(next !== undefined, `Unexpected extra API call. Prompt began: ${message.slice(0, 120)}`);
    const answer = typeof next === "function" ? next(message) : next;
    const response = await new Promise((resolve, reject) => {
      const abort = () => reject(new Error("cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve(answer).then((value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }, reject);
    });
    onEvent?.({ type: "token", text: response });
    onEvent?.({ type: "complete", answer: response });
    return { answer: response };
  },
};

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "samo-e2e-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: {
    test: "node test.js",
    typecheck: "node -e \"console.log('typecheck ok')\"",
    lint: "node -e \"console.log('lint ok')\"",
    build: "node -e \"console.log('build ok')\"",
  } }));
  fs.writeFileSync(path.join(root, "src/cart.js"), "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b);\n");
  fs.writeFileSync(path.join(root, "test.js"), 'const { total } = require("./src/cart");\nconst assert = require("assert");\nassert.equal(total([{ price: 2 }, { price: 3 }]), 5);\n');
  return root;
}

function makeProvider(store = new Map()) {
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
  void view.send({ type: "ready" });
  return {
    provider,
    view,
    posted,
    store,
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
  sentHistories = [];
});

const json = (o) => JSON.stringify(o);

test("normal chat stays conversational and excludes unrelated workspace context", async () => {
  const s = makeProvider();
  script = ["Shopify Functions run in WASM."];
  await s.ask("What is a Shopify Function?");
  assert.equal(s.last().text, "Shopify Functions run in WASM.");
  assert.doesNotMatch(prompts[0], /Workspace file tree/);
  assert.deepEqual(sentHistories[0], []);
  assert.equal(s.last().changeSet, undefined);
});

test("webview messages with invalid shapes are rejected before reaching the model", async () => {
  const s = makeProvider();
  await s.view.send({ type: "sendMessage", text: 42, includeEditorContext: false });
  assert.equal(prompts.length, 0);
  assert.equal(s.history.length, 0);
  assert.ok(s.posted.some((message) => message.type === "status" && /invalid chat action/.test(message.text)));
});

test("greetings respond immediately without replaying code history or calling the model", async () => {
  const s = makeProvider();
  script = ["A JavaScript function is a reusable block of code."];
  await s.ask("What is a JavaScript function?");
  assert.equal(prompts.length, 1);

  await s.ask("hi");

  assert.equal(prompts.length, 1);
  assert.equal(sentHistories.length, 1);
  assert.equal(s.last().text, "Hi! What can I help you with?");
});

test("project questions include workspace context only when relevant", async () => {
  const s = makeProvider();
  script = ["The workspace contains a cart module."];
  await s.ask("What files are in my project?");
  assert.match(prompts[0], /Workspace file tree/);
  assert.deepEqual(sentHistories[0], []);
});

test("visual design requests update the project and offer Keep or Undo", async () => {
  const s = makeProvider();
  const footerPath = path.join(state.root, "src/Footer.jsx");
  const original = "export default function Footer() { return <footer>Old footer</footer>; }\n";
  fs.writeFileSync(footerPath, original);
  script = [
    (message) => {
      assert.match(message, /Implement the user's request directly and completely/);
      assert.doesNotMatch(message, /First create a task list|"tasks"\s*:/i);
      assert.match(message, /src\/Footer\.jsx/);
      return json({
        summary: "Updated the footer design.",
        notes: "",
        changes: [{
          path: "src/Footer.jsx",
          action: "modify",
          expectedHash: sha256Text(original),
          content: "export default function Footer() { return <footer className=\"footer\">SaMo Studio · Contact</footer>; }\n",
        }],
      });
    },
  ];

  await s.ask("make my footer beautiful and great design");

  assert.equal(prompts.length, 1);
  assert.match(fs.readFileSync(footerPath, "utf8"), /className="footer"/);
  assert.match(s.last().text, /Updated the footer design/);
  assert.match(s.last().text, /Keep changes/);
  assert.match(s.last().text, /Undo/);
  assert.match(s.last().text, /Automated tests \(npm test\)` passed/);
  assert.ok(s.posted.some((message) => message.type === "thinking" && message.value === true));
  assert.equal(s.posted.filter((message) => message.type === "streamPreview" && message.text.includes('"type":"tool_call"')).length, 0);
});

test("coding requests stream only the final natural-language summary, not agent protocol JSON", async () => {
  const s = makeProvider();
  script = [json({ type: "final", summary: "I checked the project; no edit is needed." })];
  await s.ask("Implement a feature in the workspace");

  const previews = s.posted.filter((message) => message.type === "streamPreview").map((message) => message.text);
  assert.ok(previews.includes("I checked the project; no edit is needed."), JSON.stringify(previews));
  assert.ok(previews.every((text) => !/\"type\"\s*:\s*\"(tool_call|final)\"/.test(text)));
  assert.match(s.last().text, /no edit is needed/);
});

test("cancel stops the active model request and restores the chat controls", async () => {
  const s = makeProvider();
  let requestStarted = false;
  script = [() => {
    requestStarted = true;
    return new Promise(() => undefined);
  }];
  const pending = s.view.send({ type: "sendMessage", text: "Implement a feature", includeEditorContext: false });
  while (!requestStarted) await new Promise((resolve) => setImmediate(resolve));
  await s.view.send({ type: "cancel" });
  await pending;
  assert.match(s.last().text, /Request cancelled/);
  assert.ok(s.posted.some((message) => message.type === "thinking" && message.value === false));
});

test("conversations persist independently and legacy chat history migrates on restart", async () => {
  const s = makeProvider();
  script = ["First conversation reply", "Second conversation reply"];
  await s.ask("First conversation request");
  const first = s.provider.getConversationQuickPickItems()[0];
  assert.equal(first.label, "First conversation request");

  s.provider.startNewConversation();
  assert.equal(s.history.length, 0);
  await s.ask("Second conversation request");
  const second = s.provider.getConversationQuickPickItems()[0];
  assert.equal(second.label, "Second conversation request");
  assert.notEqual(first.id, second.id);

  await s.provider.switchConversation(first.id);
  assert.equal(s.last().text, "First conversation reply");

  const restarted = makeProvider(s.store);
  await restarted.provider.switchConversation(second.id);
  assert.equal(restarted.last().text, "Second conversation reply");
  assert.equal(restarted.provider.getConversationQuickPickItems().length, 2);

  const legacy = makeProvider(new Map([["samo.chatHistory", [
    { role: "user", text: "Migrated conversation request" },
    { role: "assistant", text: "Migrated conversation reply", images: ["data:image/png;base64,AAAA"] },
  ]]]));
  assert.equal(legacy.provider.getConversationQuickPickItems()[0].label, "Migrated conversation request");
  assert.equal(legacy.store.get("samo.chatSessions")[0].messages[1].images, undefined);
});

test("develop: implements a complete request in one model round-trip and retains checks and Undo", async () => {
  const s = makeProvider();
  fs.writeFileSync(path.join(state.root, "AGENTS.md"), "Use the existing project conventions and add regression coverage for behavior changes.\n");
  fs.writeFileSync(path.join(state.root, "old.js"), "// obsolete\n");
  script = [
    (message) => {
      assert.doesNotMatch(message, /First create a task list|"tasks"\s*:/i);
      assert.match(message, /add or update tests only when needed/i);
      assert.match(message, /Applicable repository instructions and agent skills/);
      assert.match(message, new RegExp(`src/cart\\.js \\(SHA-256: ${sha256Text("exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b);\n")}\\)`));
      return json({ summary: "Added discount support to the cart.", notes: "", changes: [
      { path: "src/discount.js", action: "create", content: "exports.applyDiscount = (n, pct) => n - n * pct / 100;\n" },
      { path: "old.js", action: "delete", expectedHash: sha256Text("// obsolete\n") },
      { path: "src/cart.js", action: "modify", expectedHash: sha256Text("exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b);\n"), edits: [{ find: "reduce((a, b) => a + b)", replace: "reduce((a, b) => a + b, 0)" }] },
      { path: "test.js", action: "modify", expectedHash: sha256Text('const { total } = require("./src/cart");\nconst assert = require("assert");\nassert.equal(total([{ price: 2 }, { price: 3 }]), 5);\n'), edits: [{ find: "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);", replace: 'assert.equal(total([{ price: 2 }, { price: 3 }]), 5);\nassert.equal(total([]), 0);\nassert.equal(require("./src/discount").applyDiscount(100, 10), 90);' }] },
    ] });
    },
  ];
  state.confirm = true;
  const history = await s.ask("Add discount support to the cart with tests");
  state.confirm = false;
  const reply = history[history.length - 1];
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(reply.text, /Task list|\bplan\b/i);
  assert.match(reply.text, /Added discount support/);
  assert.match(reply.text, /Regression checks:/);
  assert.match(reply.text, /`Automated tests \(npm test\)` passed/);
  assert.match(reply.text, /`Typecheck` passed/);
  assert.match(reply.text, /`Lint` passed/);
  assert.match(reply.text, /`Build` passed/);
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
    (msg) => { assert.match(msg, /src\/cart\.js:1/); assert.doesNotMatch(msg, /First create a task list|"tasks"\s*:/i); return json({ summary: "Attempted fix", plan: [], notes: "", changes: [{ path: "src/cart.js", action: "modify", expectedHash: sha256Text("exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b);\n"), content: "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 1);\n" }] }); },
    (msg) => { assert.match(msg, /tests failed/i); return json({ summary: "Corrected initial value", plan: [], notes: "", changes: [{ path: "src/cart.js", action: "modify", expectedHash: sha256Text("exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 1);\n"), content: "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 0);\n" }] }); },
  ];
  await s.ask(trace);
  assert.match(s.last().text, /passed after 1 automatic fix attempt/);
  assert.match(fs.readFileSync(path.join(state.root, "src/cart.js"), "utf8"), /b, 0\)/);
});

test("safety: a change set that escapes the workspace is rejected and nothing is written", async () => {
  const s = makeProvider();
  const outside = path.join(path.dirname(state.root), "pwned.txt");
  const bad = json({ summary: "x", plan: [], notes: "", changes: [{ path: "../pwned.txt", action: "create", content: "x" }] });
  script = [bad, bad];
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

test("audit-and-fix: analyzes the project, fixes a confirmed root cause, and re-runs checks", async () => {
  const s = makeProvider();
  const cartPath = path.join(state.root, "src/cart.js");
  const original = fs.readFileSync(cartPath, "utf8");
  fs.writeFileSync(
    path.join(state.root, "test.js"),
    'const { total } = require("./src/cart");\nconst assert = require("assert");\nassert.equal(total([]), 0);\n',
  );
  script = [
    (message) => {
      assert.match(message, /Current contents of relevant files/);
      assert.match(message, /Automated check results/);
      assert.match(message, /npm test: FAILED/);
      return json({
        summary: "Fixed total() to handle an empty items array.",
        plan: ["Use a zero initial value for reduce"],
        notes: "",
        changes: [{
          path: "src/cart.js",
          action: "modify",
          expectedHash: sha256Text(original),
          content: "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 0);\n",
        }],
      });
    },
  ];

  await s.ask("Analyze my current project and fix any issues");

  assert.match(fs.readFileSync(cartPath, "utf8"), /reduce\(\(a, b\) => a \+ b, 0\)/);
  assert.match(s.last().text, /Fixed total\(\)/);
  assert.match(s.last().text, /Automated tests \(npm test\)` passed/);
  assert.match(s.last().text, /Typecheck` passed/);
  assert.equal(prompts.length, 1);
});

test("selected-code error fix uses project diagnosis and regression checks", async () => {
  const s = makeProvider();
  const cartPath = path.join(state.root, "src/cart.js");
  const original = fs.readFileSync(cartPath, "utf8");
  fs.writeFileSync(
    path.join(state.root, "test.js"),
    'const { total } = require("./src/cart");\nconst assert = require("assert");\nassert.equal(total([]), 0);\n',
  );
  const doc = {
    uri: vscode.Uri.file(cartPath),
    fileName: cartPath,
    languageId: "javascript",
    isClosed: false,
    version: 1,
    getText: () => original,
  };
  vscode.window.activeTextEditor = {
    document: doc,
    selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 30 } },
  };
  script = [
    (message) => {
      assert.doesNotMatch(message, /First create a task list|"tasks"\s*:/i);
      assert.match(message, /Active editor/);
      assert.match(message, /Current contents of relevant files/);
      return json({
        summary: "Fixed total() for an empty cart.",
        plan: [],
        notes: "",
        changes: [{
          path: "src/cart.js",
          action: "modify",
          expectedHash: sha256Text(original),
          content: "exports.total = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 0);\n",
        }],
      });
    },
  ];

  await s.ask("Fix the error in the selected code");

  assert.equal(prompts.length, 1);
  assert.match(fs.readFileSync(cartPath, "utf8"), /reduce\(\(a, b\) => a \+ b, 0\)/);
  assert.match(s.last().text, /Automated tests \(npm test\)` passed/);
  vscode.window.activeTextEditor = undefined;
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
  script = [(msg) => {
    assert.match(msg, /\+\/\/ change/);
    assert.match(msg, /read-only review/i);
    return "Looks fine.";
  }];
  await s.ask("review my changes");
  assert.match(s.last().text, /Looks fine\./);
  assert.match(fs.readFileSync(path.join(state.root, "src/cart.js"), "utf8"), /\/\/ change/);

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
