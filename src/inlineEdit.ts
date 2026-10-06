import * as vscode from "vscode";

export interface LineHunk {
  /** Zero-based index of the first line in the new text. */
  start: number;
  /** Lines added or replaced in the new text. */
  added: string[];
  /** Original lines that were removed or replaced. */
  removed: string[];
}

const maxLcsCells = 4_000_000;

/** Groups the differences between two line arrays into contiguous hunks. */
export function diffLines(oldLines: string[], newLines: string[]): LineHunk[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  if (!a.length && !b.length) {
    return [];
  }
  if (!a.length || !b.length || a.length * b.length > maxLcsCells) {
    return [{ start: prefix, added: b, removed: a }];
  }

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const hunks: LineHunk[] = [];
  let current: LineHunk | undefined;
  const flush = (): void => {
    if (current) {
      hunks.push(current);
      current = undefined;
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
      current ??= { start: prefix + j, added: [], removed: [] };
      current.added.push(b[j]);
      j += 1;
    } else {
      current ??= { start: prefix + j, added: [], removed: [] };
      current.removed.push(a[i]);
      i += 1;
    }
  }
  flush();
  return hunks;
}

interface TrackedHunk {
  id: number;
  start: number;
  count: number;
  removed: string[];
}

/**
 * Applies AI edits directly to a document and exposes per-hunk Keep / Undo
 * CodeLens actions next to every edited block.
 */
export class InlineEditManager implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly hunks = new Map<string, TrackedHunk[]>();
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(46, 160, 67, 0.28)",
    borderStyle: "solid",
    borderWidth: "0 0 0 4px",
    borderColor: "#2ea043",
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: "solid",
    backgroundColor: "rgba(248, 81, 73, 0.22)",
    borderWidth: "2px 0 0 0",
    borderColor: "#f85149",
  });
  private readonly autoSave = new Set<string>();
  private nextId = 1;
  private applying = false;

  readonly onDidChangeCodeLenses = this.lensChanged.event;

  constructor() {
    this.disposables.push(
      this.lensChanged,
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.languages.registerCodeLensProvider({ scheme: "untitled" }, this),
      vscode.commands.registerCommand("samo.inlineKeep", (uri: vscode.Uri, id: number) => this.keep(uri, id)),
      vscode.commands.registerCommand("samo.inlineUndo", (uri: vscode.Uri, id: number) => this.undo(uri, id)),
      vscode.commands.registerCommand("samo.inlineKeepAll", (uri: vscode.Uri) => this.keepAll(uri)),
      vscode.commands.registerCommand("samo.inlineUndoAll", (uri: vscode.Uri) => this.undoAll(uri)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChange(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.hunks.delete(document.uri.toString());
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
    );
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.addedDecoration.dispose();
    this.removedDecoration.dispose();
  }

  /** Replaces whole lines [startLine, endLine] with newText and tracks every changed hunk. */
  async apply(document: vscode.TextDocument, startLine: number, endLine: number, newText: string): Promise<number> {
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    const oldLines = document.getText(range).split(/\r?\n/);
    const newLines = newText.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    const found = diffLines(oldLines, newLines);
    if (!found.length) {
      return 0;
    }

    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, newLines.join(eol));
    this.applying = true;
    try {
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error("VS Code rejected the edit.");
      }
    } finally {
      this.applying = false;
    }

    const key = document.uri.toString();
    const tracked = this.hunks.get(key) ?? [];
    for (const hunk of found) {
      tracked.push({ id: this.nextId++, start: startLine + hunk.start, count: hunk.added.length, removed: hunk.removed });
    }
    this.hunks.set(key, tracked);
    this.refresh();
    return found.length;
  }

  /** Registers per-hunk Keep/Undo for a document whose new content is already written. */
  track(document: vscode.TextDocument, oldText: string, newText: string): number {
    const found = diffLines(oldText.split(/\r?\n/), newText.split(/\r?\n/));
    const key = document.uri.toString();
    if (!found.length) {
      return 0;
    }
    this.hunks.set(key, found.map((hunk) => ({ id: this.nextId++, start: hunk.start, count: hunk.added.length, removed: hunk.removed })));
    this.autoSave.add(key);
    this.refresh();
    return found.length;
  }

  clear(uri: vscode.Uri): void {
    this.hunks.delete(uri.toString());
    this.autoSave.delete(uri.toString());
    this.refresh();
  }

  firstHunkLine(uri: vscode.Uri): number | undefined {
    return this.hunks.get(uri.toString())?.[0]?.start;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const tracked = this.hunks.get(document.uri.toString());
    if (!tracked?.length) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    tracked.forEach((hunk, index) => {
      const line = Math.min(hunk.start, document.lineCount - 1);
      const at = new vscode.Range(line, 0, line, 0);
      const label = hunk.count && hunk.removed.length
        ? `${hunk.removed.length} line(s) replaced`
        : hunk.count
          ? `${hunk.count} line(s) added`
          : `${hunk.removed.length} line(s) removed`;
      lenses.push(
        new vscode.CodeLens(at, { title: "$(check) KEEP", command: "samo.inlineKeep", arguments: [document.uri, hunk.id] }),
        new vscode.CodeLens(at, { title: "$(discard) UNDO", command: "samo.inlineUndo", arguments: [document.uri, hunk.id] }),
        new vscode.CodeLens(at, { title: `✦ SaMo: ${label}`, command: "" }),
      );
      if (index === 0 && tracked.length > 1) {
        lenses.push(
          new vscode.CodeLens(at, { title: "$(check-all) Keep all", command: "samo.inlineKeepAll", arguments: [document.uri] }),
          new vscode.CodeLens(at, { title: "$(close-all) Undo all", command: "samo.inlineUndoAll", arguments: [document.uri] }),
        );
      }
    });
    return lenses;
  }

  private keep(uri: vscode.Uri, id: number): void {
    this.drop(uri, id);
  }

  private keepAll(uri: vscode.Uri): void {
    this.hunks.delete(uri.toString());
    this.refresh();
  }

  private async undo(uri: vscode.Uri, id: number): Promise<void> {
    const key = uri.toString();
    const tracked = this.hunks.get(key);
    const hunk = tracked?.find((entry) => entry.id === id);
    if (!hunk) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await this.revert(document, hunk);
    this.drop(uri, id);
  }

  private async undoAll(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const tracked = this.hunks.get(key);
    if (!tracked?.length) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    for (const hunk of [...tracked].sort((left, right) => right.start - left.start)) {
      await this.revert(document, hunk);
    }
    this.hunks.delete(key);
    this.refresh();
  }

  private async revert(document: vscode.TextDocument, hunk: TrackedHunk): Promise<void> {
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const lastLine = document.lineCount - 1;
    const edit = new vscode.WorkspaceEdit();
    const old = hunk.removed.join(eol);

    if (hunk.count > 0) {
      const end = hunk.start + hunk.count - 1;
      if (hunk.removed.length) {
        edit.replace(document.uri, new vscode.Range(hunk.start, 0, end, document.lineAt(Math.min(end, lastLine)).text.length), old);
      } else if (end < lastLine) {
        edit.delete(document.uri, new vscode.Range(hunk.start, 0, end + 1, 0));
      } else if (hunk.start > 0) {
        edit.delete(document.uri, new vscode.Range(hunk.start - 1, document.lineAt(hunk.start - 1).text.length, end, document.lineAt(end).text.length));
      } else {
        edit.delete(document.uri, new vscode.Range(0, 0, end, document.lineAt(end).text.length));
      }
    } else if (hunk.start <= lastLine) {
      edit.insert(document.uri, new vscode.Position(hunk.start, 0), old + eol);
    } else {
      edit.insert(document.uri, new vscode.Position(lastLine, document.lineAt(lastLine).text.length), eol + old);
    }

    this.applying = true;
    try {
      await vscode.workspace.applyEdit(edit);
      if (this.autoSave.has(document.uri.toString())) {
        await document.save();
      }
    } finally {
      this.applying = false;
    }
  }

  private drop(uri: vscode.Uri, id: number): void {
    const key = uri.toString();
    const remaining = (this.hunks.get(key) ?? []).filter((hunk) => hunk.id !== id);
    if (remaining.length) {
      this.hunks.set(key, remaining);
    } else {
      this.hunks.delete(key);
    }
    this.refresh();
  }

  /** Keeps hunk positions correct when the user (or an Undo) edits lines above them. */
  private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    const tracked = this.hunks.get(key);
    if (!tracked?.length || !event.contentChanges.length) {
      return;
    }
    const survivors: TrackedHunk[] = [];
    for (const hunk of tracked) {
      let start = hunk.start;
      let count = hunk.count;
      let alive = true;
      for (const change of event.contentChanges) {
        const newlines = change.text.split("\n").length - 1;
        const delta = newlines - (change.range.end.line - change.range.start.line);
        const hunkEnd = start + Math.max(count, 1) - 1;
        if (change.range.end.line < start) {
          start += delta;
        } else if (change.range.start.line <= hunkEnd && !this.applying) {
          count = Math.max(count + delta, 0);
          if (count === 0 && hunk.removed.length === 0) {
            alive = false;
          }
        }
      }
      if (alive) {
        survivors.push({ ...hunk, start: Math.max(start, 0), count });
      }
    }
    if (survivors.length) {
      this.hunks.set(key, survivors);
    } else {
      this.hunks.delete(key);
    }
    this.refresh();
  }

  private enlargeCodeLens(): void {
    const config = vscode.workspace.getConfiguration("editor");
    if (
      vscode.workspace.getConfiguration("samo").get<boolean>("inlineEdit.enlargeCodeLens", true)
      && !config.get<number>("codeLensFontSize")
    ) {
      void config.update("codeLensFontSize", 15, vscode.ConfigurationTarget.Global);
    }
  }

  private refresh(): void {
    if (this.hunks.size) {
      this.enlargeCodeLens();
    }
    this.lensChanged.fire();
    this.decorateAll();
  }

  private decorateAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const tracked = this.hunks.get(editor.document.uri.toString()) ?? [];
      const lastLine = editor.document.lineCount - 1;
      editor.setDecorations(
        this.addedDecoration,
        tracked.filter((hunk) => hunk.count > 0).map((hunk) => new vscode.Range(
          Math.min(hunk.start, lastLine), 0, Math.min(hunk.start + hunk.count - 1, lastLine), 0,
        )),
      );
      editor.setDecorations(
        this.removedDecoration,
        tracked.filter((hunk) => hunk.count === 0).map((hunk) => new vscode.Range(Math.min(hunk.start, lastLine), 0, Math.min(hunk.start, lastLine), 0)),
      );
    }
  }
}
