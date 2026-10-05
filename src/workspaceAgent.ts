import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import {
  FileChange,
  TestCommand,
  applyTextEdits,
  detectTestCommand,
  isIgnoredPath,
  matchEol,
  resolveInside,
  slugify,
  tail,
} from "./agentCore";

export interface SnapshotFile {
  path: string;
  existed: boolean;
  original?: string;
  applied?: string;
}

export interface Snapshot {
  id: string;
  root: string;
  files: SnapshotFile[];
}

export interface FileResult {
  path: string;
  action: FileChange["action"];
}

export interface TestRun {
  label: string;
  passed: boolean;
  output: string;
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const fromB64 = (value: string): string => Buffer.from(value, "base64").toString("utf8");
const decoder = new TextDecoder("utf-8");

export function getWorkspaceRoot(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

export async function listWorkspaceFiles(root: string, limit = 5000): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/*"),
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,**/vendor/**,**/.venv/**,**/__pycache__/**}",
    limit,
  );
  return uris
    .map((uri) => path.relative(root, uri.fsPath).split(path.sep).join("/"))
    .filter((rel) => rel && !isIgnoredPath(rel))
    .sort();
}

export async function readWorkspaceText(root: string, rel: string, maxChars: number): Promise<string | undefined> {
  const absolute = resolveInside(root, rel);
  if (!absolute) {
    return undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolute));
    if (bytes.includes(0)) {
      return undefined;
    }
    const text = decoder.decode(bytes);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n/* ...truncated... */` : text;
  } catch {
    return undefined;
  }
}

async function assertNoSymlinkEscape(root: string, absolute: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  let probe = absolute;
  while (true) {
    try {
      const real = await fs.realpath(probe);
      const relative = path.relative(realRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("resolves outside the workspace");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        return;
      }
      probe = parent;
    }
  }
}

async function statFile(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

function fullRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

/**
 * Validates every change first, then applies them in one WorkspaceEdit so the
 * set succeeds or fails together. Originals are captured in the snapshot.
 */
export async function applyChanges(
  root: string,
  changes: FileChange[],
  snapshot: Snapshot,
): Promise<{ ok: true; results: FileResult[] } | { ok: false; errors: string[] }> {
  const edit = new vscode.WorkspaceEdit();
  const errors: string[] = [];
  const results: FileResult[] = [];
  const toSave: vscode.Uri[] = [];
  const pendingSnapshots: SnapshotFile[] = [];

  for (const change of changes) {
    const absolute = resolveInside(root, change.path);
    if (!absolute) {
      errors.push(`${change.path}: outside the workspace.`);
      continue;
    }
    try {
      await assertNoSymlinkEscape(root, absolute);
    } catch (error) {
      errors.push(`${change.path}: ${error instanceof Error ? error.message : "unsafe path"}.`);
      continue;
    }
    const uri = vscode.Uri.file(absolute);
    const stat = await statFile(uri);
    if (stat && stat.type & vscode.FileType.Directory) {
      errors.push(`${change.path}: is a directory.`);
      continue;
    }
    let document: vscode.TextDocument | undefined;
    if (stat) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) {
        errors.push(`${change.path}: binary files cannot be edited.`);
        continue;
      }
      document = await vscode.workspace.openTextDocument(uri);
    }
    const originalText = document?.getText();

    let nextText = "";
    if (change.action === "delete") {
      if (!stat) {
        errors.push(`${change.path}: cannot delete, file does not exist.`);
        continue;
      }
    } else {
      try {
        const base = originalText ?? "";
        nextText = change.content ?? applyTextEdits(base, change.edits ?? []);
        nextText = matchEol(base, nextText);
      } catch (error) {
        errors.push(`${change.path}: ${error instanceof Error ? error.message : "invalid edit"}.`);
        continue;
      }
    }

    if (!snapshot.files.some((entry) => entry.path === change.path)) {
      pendingSnapshots.push({
        path: change.path,
        existed: Boolean(stat),
        original: originalText === undefined ? undefined : b64(originalText),
      });
    }

    if (change.action === "delete") {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
    } else if (document) {
      edit.replace(uri, fullRange(document), nextText);
      toSave.push(uri);
    } else {
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), nextText);
      toSave.push(uri);
    }
    results.push({ path: change.path, action: change.action });
  }

  if (errors.length) {
    return { ok: false, errors };
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    return { ok: false, errors: ["VS Code rejected the workspace edit."] };
  }
  snapshot.files.push(...pendingSnapshots);
  for (const uri of toSave) {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await document.save();
    } catch {
      // Leave the buffer dirty; the content is still applied.
    }
  }
  await refreshAppliedState(root, snapshot);
  return { ok: true, results };
}

export async function refreshAppliedState(root: string, snapshot: Snapshot): Promise<void> {
  for (const entry of snapshot.files) {
    const absolute = resolveInside(root, entry.path);
    entry.applied = undefined;
    if (!absolute) {
      continue;
    }
    const uri = vscode.Uri.file(absolute);
    if (await statFile(uri)) {
      const document = await vscode.workspace.openTextDocument(uri);
      entry.applied = b64(document.getText());
    }
  }
}

export async function undoSnapshot(snapshot: Snapshot): Promise<{ ok: true } | { ok: false; error: string }> {
  const edit = new vscode.WorkspaceEdit();
  const conflicts: string[] = [];
  for (const entry of [...snapshot.files].reverse()) {
    const absolute = resolveInside(snapshot.root, entry.path);
    if (!absolute) {
      conflicts.push(entry.path);
      continue;
    }
    const uri = vscode.Uri.file(absolute);
    const exists = Boolean(await statFile(uri));
    const current = exists ? (await vscode.workspace.openTextDocument(uri)).getText() : undefined;
    const expected = entry.applied === undefined ? undefined : fromB64(entry.applied);
    if (current !== expected) {
      conflicts.push(entry.path);
      continue;
    }
    if (entry.existed && entry.original !== undefined) {
      const original = fromB64(entry.original);
      if (exists) {
        const document = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, fullRange(document), original);
      } else {
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), original);
      }
    } else if (exists) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
    }
  }
  if (conflicts.length) {
    return { ok: false, error: `These files changed since SaMo edited them, so undo was skipped to protect your work: ${conflicts.join(", ")}` };
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    return { ok: false, error: "VS Code rejected the undo edit." };
  }
  for (const entry of snapshot.files) {
    const absolute = resolveInside(snapshot.root, entry.path);
    if (absolute && entry.existed) {
      try {
        await (await vscode.workspace.openTextDocument(vscode.Uri.file(absolute))).save();
      } catch {
        // ignore
      }
    }
  }
  return { ok: true };
}

export async function resolveTestCommand(root: string, files: string[]): Promise<TestCommand | undefined> {
  const rootFiles = new Set(files.filter((file) => !file.includes("/")));
  const pkg = rootFiles.has("package.json") ? await readWorkspaceText(root, "package.json", 100_000) : undefined;
  return detectTestCommand(rootFiles, pkg);
}

export function runTests(root: string, command: TestCommand, timeoutMs = 180_000): Promise<TestRun> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (passed: boolean, extra = ""): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ label: command.label, passed, output: tail(`${output}${extra}`.replace(/\u001b\[[0-9;]*m/g, ""), 6000) });
    };
    const child = spawn(command.command, command.args, {
      cwd: root,
      shell: process.platform === "win32",
      env: { ...process.env, CI: "true" },
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(false, "\n[SaMo] Tests timed out.");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => finish(false, `\n[SaMo] Could not run tests: ${error.message}`));
    child.on("close", (code) => finish(code === 0));
  });
}

function git(root: string, args: string[], command = "git"): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export async function getGitDiff(root: string, maxChars = 60_000): Promise<{ diff: string; error?: string }> {
  const inRepo = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok) {
    return { diff: "", error: "This workspace is not a Git repository." };
  }
  let diff = (await git(root, ["diff", "HEAD"])).out;
  if (!diff.trim()) {
    for (const base of ["origin/main", "origin/master", "main", "master"]) {
      const result = await git(root, ["diff", `${base}...HEAD`]);
      if (result.ok && result.out.trim()) {
        diff = result.out;
        break;
      }
    }
  }
  if (!diff.trim()) {
    return { diff: "", error: "No changes found to review." };
  }
  return { diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n...[diff truncated]` : diff };
}

export async function createPullRequest(
  root: string,
  options: { title: string; body: string; files?: string[] },
): Promise<{ ok: boolean; message: string; url?: string; branch?: string }> {
  if (!(await git(root, ["rev-parse", "--is-inside-work-tree"])).ok) {
    return { ok: false, message: "This workspace is not a Git repository." };
  }
  const current = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
  const protectedBranch = /^(main|master|develop|dev|trunk|HEAD)$/.test(current);
  let branch = current;
  if (protectedBranch) {
    branch = `samo/${slugify(options.title)}-${Date.now().toString(36)}`;
    const created = await git(root, ["checkout", "-b", branch]);
    if (!created.ok) {
      return { ok: false, message: `Could not create branch: ${created.out}` };
    }
  }
  const addArgs = options.files?.length ? ["add", "--", ...options.files] : ["add", "-A"];
  const added = await git(root, addArgs);
  if (!added.ok) {
    return { ok: false, message: `git add failed: ${added.out}` };
  }
  const staged = await git(root, ["diff", "--cached", "--quiet"]);
  if (staged.ok) {
    return { ok: false, message: "There are no staged changes to commit.", branch };
  }
  const committed = await git(root, ["commit", "-m", options.title]);
  if (!committed.ok) {
    return { ok: false, message: `git commit failed: ${committed.out}`, branch };
  }
  const pushed = await git(root, ["push", "-u", "origin", branch]);
  if (!pushed.ok) {
    return { ok: false, message: `Committed on ${branch}, but push failed: ${pushed.out}`, branch };
  }
  const pr = await git(root, ["pr", "create", "--title", options.title, "--body", options.body], "gh");
  if (!pr.ok) {
    return { ok: false, message: `Pushed ${branch}, but creating the PR failed (is the GitHub CLI installed and authenticated?): ${pr.out}`, branch };
  }
  const url = pr.out.split(/\s+/).find((part) => /^https?:\/\//.test(part));
  return { ok: true, message: `Pull request created from ${branch}.`, url, branch };
}
