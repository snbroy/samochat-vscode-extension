const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

const docs = new Map();
const uriOf = (p) => ({ fsPath: p, scheme: "file" });
const vscodeMock = {
  Uri: { file: uriOf },
  FileType: { File: 1, Directory: 2 },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(s, e) { this.start = s; this.end = e; } },
  WorkspaceEdit: class {
    constructor() { this.ops = []; }
    replace(uri, _r, text) { this.ops.push(["replace", uri.fsPath, text]); }
    createFile(uri) { this.ops.push(["create", uri.fsPath]); }
    insert(uri, _p, text) { this.ops.push(["insert", uri.fsPath, text]); }
    deleteFile(uri) { this.ops.push(["delete", uri.fsPath]); }
  },
  workspace: {
    fs: {
      stat: async (uri) => { const s = fs.statSync(uri.fsPath); return { type: s.isDirectory() ? 2 : 1 }; },
      readFile: async (uri) => fs.readFileSync(uri.fsPath),
    },
    openTextDocument: async (uri) => ({
      getText: () => fs.readFileSync(uri.fsPath, "utf8"),
      positionAt: (o) => o,
      save: async () => true,
    }),
    applyEdit: async (edit) => {
      for (const [op, file, text] of edit.ops) {
        if (op === "replace") fs.writeFileSync(file, text);
        else if (op === "create") { fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, ""); }
        else if (op === "insert") fs.writeFileSync(file, text);
        else if (op === "delete") fs.rmSync(file, { force: true });
      }
      return true;
    },
  },
  window: {},
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const agent = require("../out/workspaceAgent.js");
Module._load = originalLoad;

test("apply then undo create, modify, delete; rejects escapes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "samo-")));
  fs.writeFileSync(path.join(root, "a.txt"), "hello world");
  fs.writeFileSync(path.join(root, "gone.txt"), "bye");
  const snap = { id: "1", root, files: [] };

  const bad = await agent.applyChanges(root, [{ path: "../evil.txt", action: "create", content: "x" }], snap);
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(path.join(root, "..", "evil.txt")), false);

  const ok = await agent.applyChanges(root, [
    { path: "a.txt", action: "modify", edits: [{ find: "world", replace: "samo" }] },
    { path: "new/dir/b.txt", action: "create", content: "new" },
    { path: "gone.txt", action: "delete" },
  ], snap);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello samo");
  assert.equal(fs.readFileSync(path.join(root, "new/dir/b.txt"), "utf8"), "new");
  assert.equal(fs.existsSync(path.join(root, "gone.txt")), false);

  const undo = await agent.undoSnapshot(snap);
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello world");
  assert.equal(fs.readFileSync(path.join(root, "gone.txt"), "utf8"), "bye");
  assert.equal(fs.existsSync(path.join(root, "new/dir/b.txt")), false);
});

test("undo refuses when the user edited the file afterwards", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "samo-")));
  fs.writeFileSync(path.join(root, "a.txt"), "one");
  const snap = { id: "2", root, files: [] };
  await agent.applyChanges(root, [{ path: "a.txt", action: "modify", content: "two" }], snap);
  fs.writeFileSync(path.join(root, "a.txt"), "user edit");
  const undo = await agent.undoSnapshot(snap);
  assert.equal(undo.ok, false);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "user edit");
});

test("symlinks cannot escape the workspace", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "samo-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "outside-")));
  fs.symlinkSync(outside, path.join(root, "link"));
  const res = await agent.applyChanges(root, [{ path: "link/x.txt", action: "create", content: "x" }], { id: "3", root, files: [] });
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(path.join(outside, "x.txt")), false);
});
