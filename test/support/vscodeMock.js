const fs = require("node:fs");
const path = require("node:path");

function createVscode(state) {
  const messages = [];
  const uriOf = (p) => ({ fsPath: p, scheme: "file", toString: () => `file://${p}` });
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      if (["node_modules", ".git"].includes(name)) continue;
      const full = path.join(dir, name);
      fs.statSync(full).isDirectory() ? walk(full, out) : out.push(full);
    }
    return out;
  };
  const vscode = {
    Uri: { file: uriOf, joinPath: (base, ...p) => uriOf(path.join(base.fsPath, ...p)) },
    FileType: { File: 1, Directory: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Range: class { constructor(s, e) { this.start = s; this.end = e; } },
    RelativePattern: class { constructor(base) { this.base = base; } },
    WorkspaceEdit: class {
      constructor() { this.ops = []; }
      replace(uri, _r, text) { this.ops.push(["replace", uri.fsPath, text]); }
      createFile(uri) { this.ops.push(["create", uri.fsPath]); }
      insert(uri, _p, text) { this.ops.push(["insert", uri.fsPath, text]); }
      deleteFile(uri) { this.ops.push(["delete", uri.fsPath]); }
    },
    languages: { getDiagnostics: () => state.diagnostics ?? [] },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: (cb) => { state.activeEditorListener = cb; return { dispose() {} }; },
      onDidChangeTextEditorSelection: (cb) => { state.selectionListener = cb; return { dispose() {} }; },
      showInformationMessage: async (...args) => { state.infoMessages.push(args[0]); return state.confirm ? "Create PR" : undefined; },
      showWarningMessage: async (m) => { state.warnings.push(m); },
      showErrorMessage: async (m) => { state.errors.push(m); },
    },
    workspace: {
      isTrusted: true,
      get workspaceFolders() { return [{ uri: uriOf(state.root) }]; },
      getWorkspaceFolder: () => ({ uri: uriOf(state.root) }),
      asRelativePath: (u) => path.relative(state.root, u.fsPath),
      getConfiguration: () => ({ get: (k, d) => state.config[k] ?? d }),
      findFiles: async () => walk(state.root).map(uriOf),
      fs: {
        stat: async (uri) => { const s = fs.statSync(uri.fsPath); return { type: s.isDirectory() ? 2 : 1 }; },
        readFile: async (uri) => fs.readFileSync(uri.fsPath),
      },
      openTextDocument: async (uri) => ({
        uri,
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
  };
  return { vscode, messages };
}
module.exports = { createVscode };
