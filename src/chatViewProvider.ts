import * as vscode from "vscode";
import { SamoApiClient } from "./apiClient";
import {
  FileChange,
  ChangeSetPayload,
  addLineNumbers,
  batchByBudget,
  detectIntent,
  developJsonContract,
  extractErrorFiles,
  extractJson,
  parsePlan,
  planJsonContract,
  renderTaskBoard,
  TaskState,
  findMentionedPaths,
  formatFileTree,
  mentionsEditor,
  parseChangeSet,
  rankFilesByKeywords,
  sortByUnderstandingPriority,
  tail,
} from "./agentCore";
import {
  Snapshot,
  TestRun,
  applyChanges,
  createPullRequest,
  getGitDiff,
  getWorkspaceRoot,
  listWorkspaceFiles,
  readWorkspaceText,
  resolveTestCommand,
  runTests,
  undoSnapshot,
} from "./workspaceAgent";

interface LegacyFix {
  id: string;
  status: string;
}

interface ChangeSetRecord {
  id: string;
  status: "applied" | "kept" | "undone" | "failed";
  files: Array<{ path: string; action: FileChange["action"] }>;
  tests?: Array<{ label: string; passed: boolean }>;
  title: string;
  body: string;
  prUrl?: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  fix?: LegacyFix;
  changeSet?: ChangeSetRecord;
  retry?: {
    text: string;
    includeEditorContext: boolean;
  };
}

const historyStateKey = "samo.chatHistory";
const snapshotStateKey = "samo.snapshots";
const projectModelKey = "samo.projectModel";
const maxStoredSnapshots = 8;
const streamRenderIntervalMs = 75;
const obsoleteEditorContextError = "Open a file in the editor before including editor context.";
const developContextBudget = 80_000;
const understandBatchChars = 24_000;
const maxUnderstandBatches = 14;
const personaPrefix = "You are SaMo, an expert Shopify-focused software engineer working inside the user's VS Code workspace.";

class AgentError extends Error {}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "samo.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[];
  private snapshots: Snapshot[];
  private idCounter = 0;
  private requestInFlight = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly apiClient: SamoApiClient,
  ) {
    this.history = context.workspaceState.get<ChatMessage[]>(historyStateKey, []);
    this.snapshots = context.workspaceState.get<Snapshot[]>(snapshotStateKey, []);
    this.history = this.history.filter(
      (message) => !(message.role === "system" && message.text === obsoleteEditorContextError),
    );
    for (const message of this.history) {
      if (message.fix) {
        message.fix.status = message.fix.status === "applied" || message.fix.status === "kept" ? "kept" : "dismissed";
      }
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "ready":
            this.postHistory();
            break;
          case "sendMessage":
            await this.handleUserMessage(String(message.text ?? ""), Boolean(message.includeEditorContext));
            break;
          case "retry":
            await this.retryMessage(Number(message.index));
            break;
          case "keepChangeSet":
            this.keepChangeSet(String(message.id ?? ""));
            break;
          case "undoChangeSet":
            await this.undoChangeSet(String(message.id ?? ""));
            break;
          case "createPr":
            await this.createPrFor(String(message.id ?? ""));
            break;
          case "reviewChanges":
            await this.handleUserMessage("Review my changes and suggest revisions.");
            break;
          case "clear":
            this.clearHistory();
            break;
          default:
            break;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown error.";
        void vscode.window.showErrorMessage(`SaMo: ${detail}`);
      }
    });
  }

  clearHistory(): void {
    this.history = [];
    void this.context.workspaceState.update(historyStateKey, this.history);
    this.view?.webview.postMessage({ type: "history", messages: this.history });
  }

  private postHistory(): void {
    this.view?.webview.postMessage({ type: "history", messages: this.history });
  }

  private persistHistory(): void {
    void this.context.workspaceState.update(historyStateKey, this.history);
    this.postHistory();
  }

  private persistSnapshots(): void {
    this.snapshots = this.snapshots.slice(-maxStoredSnapshots);
    void this.context.workspaceState.update(snapshotStateKey, this.snapshots);
  }

  private newId(): string {
    this.idCounter += 1;
    return `${Date.now()}-${this.idCounter}`;
  }

  private status(text: string): void {
    this.view?.webview.postMessage({ type: "status", text });
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("samo").get<T>(key, fallback);
  }

  private async retryMessage(index: number): Promise<void> {
    if (this.requestInFlight) {
      return;
    }
    const failedMessage = this.history[index];
    if (failedMessage?.role !== "system" || !failedMessage.retry) {
      return;
    }

    let userIndex = -1;
    for (let messageIndex = index - 1; messageIndex >= 0; messageIndex--) {
      const message = this.history[messageIndex];
      if (message.role === "user" && message.text === failedMessage.retry.text) {
        userIndex = messageIndex;
        break;
      }
    }
    this.history.splice(index, 1);
    if (userIndex >= 0) {
      this.history.splice(userIndex, 1);
    }
    await this.handleUserMessage(failedMessage.retry.text, failedMessage.retry.includeEditorContext);
  }

  private async ask(message: string, history: Array<{ role: "user" | "assistant"; content: string }> = []): Promise<string> {
    const result = await this.apiClient.sendMessage(message, history, (event) => {
      if (event.type === "status" && event.message) {
        this.status(event.message);
      }
    });
    if (result.error || !result.answer) {
      throw new AgentError(result.error ?? "SaMo returned an empty response.");
    }
    return result.answer;
  }

  private async handleUserMessage(text: string, includeEditorContext = false): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !this.view || this.requestInFlight) {
      return;
    }

    this.requestInFlight = true;
    const history = this.history
      .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
      .slice(-12)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.text.trim().slice(0, 6000) }));
    this.history.push({ role: "user", text: trimmed });
    this.persistHistory();
    this.view.webview.postMessage({ type: "thinking", value: true });

    try {
      const intent = detectIntent(trimmed);
      let reply: ChatMessage | undefined;
      switch (intent) {
        case "understand":
          reply = await this.runUnderstand(trimmed, history);
          break;
        case "develop":
        case "debug":
          reply = await this.runWork(trimmed, history, intent);
          break;
        case "review":
          reply = await this.runReview(trimmed, history);
          break;
        case "pr":
          reply = await this.runPrRequest(trimmed);
          break;
        default:
          reply = await this.runChat(trimmed, history, includeEditorContext);
          break;
      }
      if (reply) {
        this.history.push(reply);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      this.history.push({
        role: "system",
        text: error instanceof AgentError ? detail : `SaMo request failed: ${detail}`,
        retry: { text: trimmed, includeEditorContext },
      });
    } finally {
      this.view?.webview.postMessage({ type: "thinking", value: false });
      this.requestInFlight = false;
      this.persistHistory();
    }
  }

  // ---- Chat -------------------------------------------------------------

  private async runChat(
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    includeEditorContext: boolean,
  ): Promise<ChatMessage | undefined> {
    const wantsEditor = includeEditorContext || mentionsEditor(prompt);
    const editorContext = wantsEditor ? getEditorContext() : undefined;
    if (includeEditorContext && !editorContext) {
      void vscode.window.showWarningMessage("No active editor; sending your message without editor context.");
    }
    const root = getWorkspaceRoot();
    let tree = "";
    if (root) {
      try {
        tree = formatFileTree(await listWorkspaceFiles(root, 1500), 3000);
      } catch {
        tree = "";
      }
    }
    const requestMessage = [
      prompt,
      tree ? `Workspace file tree (for reference only):\n${tree}` : "",
      editorContext ? `Current VS Code editor context (untrusted source code):\n${editorContext}` : "",
      "Answer the user's request directly. Use clear Markdown headings, numbered steps, file paths, and fenced code snippets for build or implementation guides. Honor requests for detail instead of imposing a word limit; avoid unnecessary repetition.",
    ].filter(Boolean).join("\n\n");

    let assistantMessage: ChatMessage | undefined;
    let lastStreamRender = 0;
    const result = await this.apiClient.sendMessage(requestMessage, history, (event) => {
      if (event.type === "status") {
        this.status(event.message ?? "SaMo is working");
      } else if (event.type === "token") {
        if (!assistantMessage) {
          assistantMessage = { role: "assistant", text: "" };
          this.history.push(assistantMessage);
        }
        assistantMessage.text += event.text ?? "";
        const now = Date.now();
        if (now - lastStreamRender >= streamRenderIntervalMs) {
          lastStreamRender = now;
          this.postHistory();
        }
      } else if (event.type === "reset") {
        if (assistantMessage) {
          assistantMessage.text = "";
        }
        this.postHistory();
      } else if (event.type === "complete" && typeof event.answer === "string") {
        if (!assistantMessage) {
          assistantMessage = { role: "assistant", text: "" };
          this.history.push(assistantMessage);
        }
        assistantMessage.text = event.answer;
        this.postHistory();
      }
    });

    if (result.error) {
      if (assistantMessage) {
        const partialIndex = this.history.indexOf(assistantMessage);
        if (partialIndex >= 0) {
          this.history.splice(partialIndex, 1);
        }
      }
      throw new AgentError(result.error);
    }
    if (assistantMessage) {
      assistantMessage.text = result.answer ?? assistantMessage.text;
      return undefined;
    }
    return { role: "assistant", text: result.answer ?? "" };
  }

  // ---- Understand -------------------------------------------------------

  private async runUnderstand(
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<ChatMessage> {
    const root = requireRoot();
    this.status("Scanning workspace…");
    const allFiles = await listWorkspaceFiles(root);
    if (!allFiles.length) {
      throw new AgentError("The workspace has no readable source files.");
    }
    const mentioned = findMentionedPaths(prompt, allFiles);
    const scoped = mentioned.files.length || mentioned.folders.length;
    let targets = allFiles;
    if (scoped) {
      targets = allFiles.filter(
        (file) => mentioned.files.includes(file) || mentioned.folders.some((folder) => file.startsWith(`${folder}/`)),
      );
    }
    const maxFiles = Math.max(10, this.config<number>("maxUnderstandFiles", 80));
    const ordered = sortByUnderstandingPriority(targets).slice(0, maxFiles);

    const items: Array<{ path: string; content: string }> = [];
    for (const [index, file] of ordered.entries()) {
      if (index % 10 === 0) {
        this.status(`Reading files ${index + 1}-${Math.min(index + 10, ordered.length)} of ${ordered.length}…`);
      }
      const content = await readWorkspaceText(root, file, 40_000);
      if (content !== undefined && content.trim()) {
        items.push({ path: file, content: addLineNumbers(content) });
      }
    }
    if (!items.length) {
      throw new AgentError("No readable text files were found for that scope.");
    }

    const tree = formatFileTree(allFiles, 8000);
    const batches = batchByBudget(items, understandBatchChars).slice(0, maxUnderstandBatches);
    const notes: string[] = [];
    if (batches.length > 1) {
      for (const [index, batch] of batches.entries()) {
        this.status(`Analyzing code batch ${index + 1} of ${batches.length}…`);
        const batchPrompt = [
          `${personaPrefix} Read these source files line by line and write dense factual notes for a later architecture write-up.`,
          "For each file give: purpose, key exports/functions/classes (with line numbers), imports and external dependencies, API/DB/Shopify usage, data flow, and any bugs, TODOs or missing pieces. Do not invent anything not in the code.",
          batch.map((item) => `### ${item.path}\n${item.content}`).join("\n\n"),
        ].join("\n\n");
        notes.push(await this.ask(batchPrompt));
      }
    }

    this.status("Building project understanding…");
    const finalPrompt = [
      `${personaPrefix} The user asked: "${prompt}"`,
      scoped ? `Scope: ${[...mentioned.files, ...mentioned.folders].join(", ")}` : "Scope: the whole workspace.",
      `Workspace file tree:\n${tree}`,
      batches.length > 1
        ? `Per-file notes from reading every file line by line:\n\n${notes.join("\n\n---\n\n")}`
        : `Source files (line numbered):\n\n${batches[0].map((item) => `### ${item.path}\n${item.content}`).join("\n\n")}`,
      "Write a clear Markdown report with these sections: Overview; Tech stack and frameworks; Entry points; Architecture and module relationships (include a text dependency graph); Data flow and APIs; Database/state; Shopify extensions/functions if any; Tests, build and deployment; Risks and gaps; Suggested next features. Reference file paths and line numbers. Be accurate and concise.",
    ].join("\n\n");
    const report = await this.ask(finalPrompt, history.slice(-4));

    if (!scoped) {
      await this.context.workspaceState.update(`${projectModelKey}:${root}`, {
        summary: report.slice(0, 8000),
        createdAt: Date.now(),
        fileCount: allFiles.length,
      });
    }
    const skipped = targets.length - ordered.length;
    const footer = skipped > 0
      ? `\n\n_Read ${items.length} of ${targets.length} files (limit \`samo.maxUnderstandFiles\`)._`
      : `\n\n_Read ${items.length} files. SaMo will use this understanding when you ask it to build features._`;
    return { role: "assistant", text: report + footer };
  }

  // ---- Develop / Review -------------------------------------------------

  private async buildDevelopContext(root: string, prompt: string, files: string[], seed: string[] = []): Promise<string> {
    const mentioned = findMentionedPaths(prompt, files);
    const picked: string[] = [];
    const add = (file: string): void => {
      if (!picked.includes(file)) {
        picked.push(file);
      }
    };
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const rel = vscode.workspace.asRelativePath(active, false).replace(/\\/g, "/");
      if (files.includes(rel)) {
        add(rel);
      }
    }
    seed.filter((file) => files.includes(file)).forEach(add);
    mentioned.files.forEach(add);
    mentioned.folders.forEach((folder) => files.filter((file) => file.startsWith(`${folder}/`)).slice(0, 10).forEach(add));
    rankFilesByKeywords(prompt, files, 8).forEach(add);
    if (files.includes("package.json")) {
      add("package.json");
    }

    let budget = developContextBudget;
    const blocks: string[] = [];
    for (const file of picked) {
      if (budget <= 0) {
        break;
      }
      const content = await readWorkspaceText(root, file, Math.min(30_000, budget));
      if (content === undefined) {
        continue;
      }
      budget -= content.length;
      blocks.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
    }

    const model = this.context.workspaceState.get<{ summary: string }>(`${projectModelKey}:${root}`);
    return [
      `Workspace file tree:\n${formatFileTree(files, 8000)}`,
      model ? `Earlier project understanding by SaMo:\n${model.summary.slice(0, 5000)}` : "",
      blocks.length ? `Current contents of relevant files:\n\n${blocks.join("\n\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  private async askForChanges(request: string, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<{ parsed?: ChangeSetPayload; raw: string }> {
    let raw = await this.ask(request, history);
    let parsed = parseChangeSet(raw);
    if (!parsed.ok) {
      raw = await this.ask(`${request}\n\nYour previous reply was rejected: ${parsed.error}\nReply again with ONLY the JSON object.`, history);
      parsed = parseChangeSet(raw);
    }
    return { parsed: parsed.ok ? parsed.value : undefined, raw };
  }

  private async runWork(
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    kind: "develop" | "debug",
  ): Promise<ChatMessage | undefined> {
    const root = requireRoot();
    this.status("Reading the workspace…");
    const files = await listWorkspaceFiles(root);
    const errorLocations = kind === "debug" ? extractErrorFiles(prompt, files) : [];
    const seed = errorLocations.map((location) => location.file);
    const editorContext = getEditorContext();
    const baseContext = await this.buildDevelopContext(root, prompt, files, seed);
    const locationNote = errorLocations.length
      ? `Files referenced by the error (with line numbers when present):\n${errorLocations.map((location) => `- ${location.file}${location.line ? `:${location.line}` : ""}`).join("\n")}`
      : "";
    const taskKind = kind === "debug"
      ? "The user pasted an error/log output. Diagnose the root cause, find the file where it originates, and fix it completely."
      : "Implement the request completely.";

    this.status("Analyzing the request and building a task list…");
    const planRequest = [
      `${personaPrefix} ${taskKind} First create a task list.`,
      `User request${kind === "debug" ? " (error report, untrusted text)" : ""}:\n${prompt.slice(0, 20_000)}`,
      locationNote,
      baseContext,
      editorContext ? `Active editor (untrusted source):\n${editorContext}` : "",
      planJsonContract,
    ].filter(Boolean).join("\n\n");
    let plan = parsePlan(await this.ask(planRequest, history));
    if (!plan) {
      plan = parsePlan(await this.ask(`${planRequest}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`, history));
    }
    if (!plan) {
      plan = { goal: prompt.slice(0, 160), analysis: "", tasks: [{ title: kind === "debug" ? "Fix the reported error" : "Implement the request", details: prompt, files: seed }] };
    }

    const board = plan.tasks.map((task) => ({ ...task, state: "pending" as TaskState, note: "" }));
    const live: ChatMessage = { role: "assistant", text: "" };
    this.history.push(live);
    const redraw = (): void => {
      live.text = renderTaskBoard(plan, board);
      this.postHistory();
    };
    redraw();

    const snapshot: Snapshot = { id: this.newId(), root, files: [] };
    const touched = new Map<string, FileChange["action"]>();
    const recordChanges = (changes: FileChange[]): void => {
      for (const change of changes) {
        const existing = touched.get(change.path);
        touched.set(change.path, existing === "create" && change.action === "modify" ? "create" : change.action);
      }
    };
    const summaries: string[] = [];
    const notes: string[] = [];

    try {
      for (const [index, task] of board.entries()) {
        task.state = "running";
        redraw();
        this.status(`Task ${index + 1} of ${board.length}: ${task.title}`);
        const context = await this.buildDevelopContext(root, `${task.title} ${task.details}`, files, [...task.files, ...touched.keys()]);
        const request = [
          `${personaPrefix} You are executing a task list one task at a time. Implement ONLY the current task completely, building on files already changed by earlier tasks.`,
          `Overall request:\n${prompt.slice(0, 20_000)}`,
          `Task list:\n${board.map((entry, i) => `${i + 1}. [${entry.state === "done" ? "done" : i === index ? "CURRENT" : "todo"}] ${entry.title}`).join("\n")}`,
          `Current task: ${task.title}\n${task.details}`,
          locationNote,
          context,
          developJsonContract,
        ].filter(Boolean).join("\n\n");

        const { parsed } = await this.askForChanges(request, []);
        if (!parsed) {
          task.state = "failed";
          task.note = "model did not return valid changes";
          redraw();
          continue;
        }
        if (!parsed.changes.length) {
          task.state = "done";
          task.note = "no change needed";
          if (parsed.summary) {
            summaries.push(parsed.summary);
          }
          redraw();
          continue;
        }
        let payload = parsed;
        let applied = await applyChanges(root, payload.changes, snapshot);
        if (!applied.ok) {
          const retry = await this.askForChanges(`${request}\n\nYour changes could not be applied:\n${applied.errors.join("\n")}\nReply again with corrected JSON only.`, []);
          if (retry.parsed?.changes.length) {
            payload = retry.parsed;
            applied = await applyChanges(root, payload.changes, snapshot);
          }
        }
        if (!applied.ok) {
          task.state = "failed";
          task.note = applied.errors[0];
          redraw();
          continue;
        }
        recordChanges(payload.changes);
        if (payload.summary) {
          summaries.push(payload.summary);
        }
        if (payload.notes) {
          notes.push(payload.notes);
        }
        task.state = "done";
        task.note = `${payload.changes.length} file(s)`;
        redraw();
      }

      if (!touched.size) {
        const index = this.history.indexOf(live);
        if (index >= 0) {
          this.history.splice(index, 1);
        }
        return {
          role: "assistant",
          text: `${renderTaskBoard(plan, board)}\n\nNo file changes were made.${notes.length ? `\n\n${notes.join("\n")}` : ""}`,
        };
      }

      const { tests, testNote } = await this.verify(root, files, snapshot, touched, prompt, recordChanges);
      this.snapshots.push(snapshot);
      this.persistSnapshots();

      const finalRun = tests[tests.length - 1];
      const failedTasks = board.filter((task) => task.state === "failed").length;
      const lines: string[] = [renderTaskBoard(plan, board)];
      if (summaries.length) {
        lines.push("", "**Summary**", ...summaries.map((entry) => `- ${entry}`));
      }
      lines.push("", "**Files**", ...[...touched].map(([path, action]) => `- ${action === "create" ? "➕ created" : action === "delete" ? "🗑️ deleted" : "✏️ modified"} \`${path}\``));
      lines.push("", ...this.describeTests(tests, testNote));
      if (failedTasks) {
        lines.push("", `⚠️ ${failedTasks} task(s) could not be completed; review them above.`);
      }
      if (notes.length) {
        lines.push("", `**Notes**\n${notes.join("\n")}`);
      }
      lines.push("", "_Changes were applied to your workspace. Use **Undo** to revert them or **Keep changes** to accept._");

      live.text = lines.join("\n");
      live.changeSet = {
        id: snapshot.id,
        status: "applied",
        files: [...touched].map(([path, action]) => ({ path, action })),
        tests: finalRun ? [{ label: finalRun.label, passed: finalRun.passed }] : undefined,
        title: makeTitle(plan.goal, prompt),
        body: [plan.goal, ...board.map((task) => `- ${task.state === "done" ? "[x]" : "[ ]"} ${task.title}`), finalRun ? `Tests: ${finalRun.label} ${finalRun.passed ? "passed" : "failed"}` : ""].filter(Boolean).join("\n"),
      };
      return undefined;
    } catch (error) {
      if (touched.size) {
        // Keep partial work undoable instead of orphaning applied edits.
        this.snapshots.push(snapshot);
        this.persistSnapshots();
        live.text = `${renderTaskBoard(plan, board)}\n\n⚠️ SaMo stopped early: ${error instanceof Error ? error.message : "unknown error"}\n\nChanges already applied can be undone below.`;
        live.changeSet = {
          id: snapshot.id,
          status: "applied",
          files: [...touched].map(([path, action]) => ({ path, action })),
          title: makeTitle(plan.goal, prompt),
          body: plan.goal,
        };
        return undefined;
      }
      const index = this.history.indexOf(live);
      if (index >= 0) {
        this.history.splice(index, 1);
      }
      throw error;
    }
  }

  private describeTests(tests: TestRun[], testNote: string): string[] {
    const finalRun = tests[tests.length - 1];
    if (!finalRun) {
      return testNote ? [testNote] : [];
    }
    return [finalRun.passed
      ? `**Regression tests:** ✅ \`${finalRun.label}\` passed${tests.length > 1 ? ` after ${tests.length - 1} automatic fix attempt(s)` : ""}.`
      : `**Regression tests:** ❌ \`${finalRun.label}\` still failing after ${tests.length - 1} fix attempt(s). Review the output:\n\n\`\`\`\n${tail(finalRun.output, 1500)}\n\`\`\``];
  }

  private async verify(
    root: string,
    files: string[],
    snapshot: Snapshot,
    touched: Map<string, FileChange["action"]>,
    title: string,
    recordChanges: (changes: FileChange[]) => void,
  ): Promise<{ tests: TestRun[]; testNote: string }> {
    const tests: TestRun[] = [];
    if (!this.config<boolean>("runTests", true)) {
      return { tests, testNote: "" };
    }
    if (!vscode.workspace.isTrusted) {
      return { tests, testNote: "⚠️ Tests were skipped because the workspace is not trusted." };
    }
    const command = await resolveTestCommand(root, files);
    if (!command) {
      return { tests, testNote: "⚠️ No test command was detected (add a `test` script to `package.json`)." };
    }
    const maxFix = Math.max(0, Math.min(5, this.config<number>("maxFixIterations", 2)));
    this.status(`Running regression tests (${command.label})…`);
    let run = await runTests(root, command);
    tests.push(run);
    for (let attempt = 1; attempt <= maxFix && !run.passed; attempt++) {
      this.status(`Tests failed — asking SaMo to fix (attempt ${attempt} of ${maxFix})…`);
      const current: string[] = [];
      for (const [file, action] of touched) {
        if (action === "delete") {
          continue;
        }
        const content = await readWorkspaceText(root, file, 20_000);
        if (content !== undefined) {
          current.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
        }
      }
      const fixRequest = [
        `${personaPrefix} Your previous changes were applied but the regression tests failed. Fix the code or the tests.`,
        `Original request:\n${title}`,
        `Test command: ${command.label}\nFailure output:\n${run.output}`,
        `Current contents of files you changed:\n${current.join("\n\n")}`,
        developJsonContract,
      ].join("\n\n");
      const fixed = await this.askForChanges(fixRequest, []);
      if (!fixed.parsed?.changes.length) {
        break;
      }
      const result = await applyChanges(root, fixed.parsed.changes, snapshot);
      if (!result.ok) {
        break;
      }
      recordChanges(fixed.parsed.changes);
      this.status(`Re-running regression tests (${command.label})…`);
      run = await runTests(root, command);
      tests.push(run);
    }
    return { tests, testNote: "" };
  }

  private async applyAndVerify(
    root: string,
    files: string[],
    request: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    first: ChangeSetPayload,
    title: string,
    reviewText?: string,
  ): Promise<ChatMessage> {
    const lead = reviewText ? `${reviewText}\n\n` : "";
    if (!first.changes.length) {
      return { role: "assistant", text: `${lead}${first.summary || "No file changes were needed."}${first.notes ? `\n\n${first.notes}` : ""}` };
    }

    const snapshot: Snapshot = { id: this.newId(), root, files: [] };
    let payload = first;
    this.status(`Applying ${payload.changes.length} file change(s)…`);
    let applied = await applyChanges(root, payload.changes, snapshot);
    if (!applied.ok) {
      const retryRequest = `${request}\n\nYour changes could not be applied:\n${applied.errors.join("\n")}\nReply again with corrected JSON only.`;
      const second = await this.askForChanges(retryRequest, history);
      if (second.parsed?.changes.length) {
        payload = second.parsed;
        applied = await applyChanges(root, payload.changes, snapshot);
      }
    }
    if (!applied.ok) {
      return {
        role: "assistant",
        text: `${lead}SaMo prepared changes but none were applied because validation failed:\n\n${applied.errors.map((error) => `- ${error}`).join("\n")}`,
      };
    }

    const touched = new Map<string, FileChange["action"]>();
    const recordChanges = (changes: FileChange[]): void => {
      for (const change of changes) {
        const existing = touched.get(change.path);
        touched.set(change.path, existing === "create" && change.action === "modify" ? "create" : change.action);
      }
    };
    recordChanges(payload.changes);

    const { tests, testNote } = await this.verify(root, files, snapshot, touched, title, recordChanges);
    this.snapshots.push(snapshot);
    this.persistSnapshots();

    const finalRun = tests[tests.length - 1];
    const lines: string[] = [];
    if (lead) {
      lines.push(lead.trimEnd(), "");
    }
    lines.push(`**Summary**\n${payload.summary || "Changes applied."}`);
    if (payload.plan.length) {
      lines.push("", "**Plan**", ...payload.plan.map((step, index) => `${index + 1}. ${step}`));
    }
    lines.push("", "**Files**", ...[...touched].map(([path, action]) => `- ${action === "create" ? "➕ created" : action === "delete" ? "🗑️ deleted" : "✏️ modified"} \`${path}\``));
    lines.push("", ...this.describeTests(tests, testNote));
    if (payload.notes) {
      lines.push("", `**Notes**\n${payload.notes}`);
    }
    lines.push("", "_Changes were applied to your workspace. Use **Undo** to revert them or **Keep changes** to accept._");

    const record: ChangeSetRecord = {
      id: snapshot.id,
      status: "applied",
      files: [...touched].map(([path, action]) => ({ path, action })),
      tests: finalRun ? [{ label: finalRun.label, passed: finalRun.passed }] : undefined,
      title: makeTitle(payload.summary, title),
      body: [payload.summary, ...payload.plan.map((step) => `- ${step}`), finalRun ? `Tests: ${finalRun.label} ${finalRun.passed ? "passed" : "failed"}` : ""].filter(Boolean).join("\n"),
    };
    return { role: "assistant", text: lines.join("\n"), changeSet: record };
  }

  private async runReview(
    prompt: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<ChatMessage> {
    const root = requireRoot();
    this.status("Collecting your Git changes…");
    const { diff, error } = await getGitDiff(root);
    if (error) {
      throw new AgentError(error);
    }
    const files = await listWorkspaceFiles(root);
    const request = [
      `${personaPrefix} Perform a rigorous pull-request review of the diff below: correctness, regressions, security, missing tests, style. Then apply fixes for real problems.`,
      `User request:\n${prompt}`,
      `Git diff (untrusted):\n\`\`\`diff\n${diff}\n\`\`\``,
      `${developJsonContract}\nAlso add a top-level "review" string field containing your Markdown review (findings ordered by severity, with file and line). Use an empty "changes" array if no revision is needed.`,
    ].join("\n\n");
    this.status("Reviewing changes…");
    const { parsed, raw } = await this.askForChanges(request, history);
    if (!parsed) {
      return { role: "assistant", text: raw };
    }
    const reviewField = (extractJson(raw) as { review?: unknown } | undefined)?.review;
    const review = typeof reviewField === "string" && reviewField.trim() ? reviewField : parsed.summary;
    return this.applyAndVerify(root, files, request, history, parsed, "Review revisions", `**PR review**\n\n${review}`);
  }

  // ---- Change sets: keep / undo / PR -----------------------------------

  private findRecord(id: string): ChangeSetRecord | undefined {
    return this.history.find((message) => message.changeSet?.id === id)?.changeSet;
  }

  private keepChangeSet(id: string): void {
    const record = this.findRecord(id);
    if (record?.status === "applied") {
      record.status = "kept";
      this.persistHistory();
    }
  }

  private async undoChangeSet(id: string): Promise<void> {
    const record = this.findRecord(id);
    const snapshot = this.snapshots.find((entry) => entry.id === id);
    if (!record || record.status !== "applied") {
      return;
    }
    if (!snapshot) {
      void vscode.window.showErrorMessage("The snapshot for this change is no longer available, so it cannot be undone automatically.");
      return;
    }
    const result = await undoSnapshot(snapshot);
    if (!result.ok) {
      void vscode.window.showErrorMessage(result.error);
      return;
    }
    record.status = "undone";
    this.snapshots = this.snapshots.filter((entry) => entry.id !== id);
    this.persistSnapshots();
    this.persistHistory();
  }

  private async runPrRequest(prompt: string): Promise<ChatMessage> {
    const record = [...this.history].reverse().find((message) => message.changeSet && (message.changeSet.status === "applied" || message.changeSet.status === "kept") && !message.changeSet.prUrl)?.changeSet;
    const result = await this.openPullRequest(record, prompt);
    return { role: "assistant", text: result };
  }

  private async createPrFor(id: string): Promise<void> {
    const record = this.findRecord(id);
    if (!record || this.requestInFlight) {
      return;
    }
    this.requestInFlight = true;
    this.view?.webview.postMessage({ type: "thinking", value: true });
    try {
      const text = await this.openPullRequest(record, record.title);
      this.history.push({ role: "assistant", text });
    } finally {
      this.view?.webview.postMessage({ type: "thinking", value: false });
      this.requestInFlight = false;
      this.persistHistory();
    }
  }

  private async openPullRequest(record: ChangeSetRecord | undefined, fallbackTitle: string): Promise<string> {
    const root = requireRoot();
    const title = record?.title ?? makeTitle("", fallbackTitle);
    const scope = record ? `${record.files.length} file(s) from the latest SaMo change set` : "ALL uncommitted changes in the workspace";
    const choice = await vscode.window.showInformationMessage(
      `Create a pull request "${title}"?`,
      { modal: true, detail: `SaMo will create a branch if you are on a default branch, commit ${scope}, push to origin, and open a PR with the GitHub CLI.` },
      "Create PR",
    );
    if (choice !== "Create PR") {
      return "Pull request creation was cancelled.";
    }
    this.status("Creating branch, committing and opening the pull request…");
    const files = record?.files.map((file) => file.path);
    const result = await createPullRequest(root, {
      title,
      body: `${record?.body ?? title}\n\n_Created with SaMo for VS Code._`,
      files,
    });
    if (result.ok && record) {
      record.prUrl = result.url ?? "created";
    }
    return result.ok
      ? `✅ ${result.message}${result.url ? `\n\n${result.url}` : ""}`
      : `❌ ${result.message}`;
  }

  private renderHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.bundle.js"));
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>SaMo Chat</title>
</head>
<body>
  <div class="chat-root">
    <div class="chat-header">
      <div class="chat-title">
        <span class="chat-avatar">S</span>
        <span>SaMo</span>
      </div>
      <button id="clear-btn" class="icon-btn" title="Clear conversation">Clear</button>
    </div>
    <div id="messages" class="messages"></div>
    <div id="empty-state" class="empty-state">
      <h2>Ask SaMo anything</h2>
      <p>Your Shopify engineering assistant. Set your API URL, email, and access token in settings, then start chatting.</p>
      <ul class="empty-hints">
        <li>"Understand this project" reads your code and maps the architecture.</li>
        <li>"Add a wishlist feature" edits files, adds tests, and runs them.</li>
        <li>"Review my changes" then "Create PR" for end-to-end delivery.</li>
      </ul>
    </div>
    <div class="composer">
      <label class="context-toggle" title="Code-change requests automatically include the workspace tree and relevant files.">
        <input id="editor-context" type="checkbox" />
        <span>Include editor context</span>
      </label>
      <div class="composer-input">
        <textarea id="input" rows="1" placeholder="Message SaMo..."></textarea>
        <button id="send-btn" class="send-btn" title="Send message" disabled>&#10148;</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }}

function requireRoot(): string {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new AgentError("Open a folder in VS Code first — SaMo needs a workspace to read and edit code.");
  }
  return root;
}

function makeTitle(summary: string, fallback: string): string {
  const source = (summary || fallback).replace(/\s+/g, " ").trim();
  const sentence = source.split(/(?<=[.!?])\s/)[0] ?? source;
  return sentence.length > 72 ? `${sentence.slice(0, 69)}...` : sentence;
}

function getEditorContext(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const document = editor.document;
  const hasSelection = !editor.selection.isEmpty;
  const text = hasSelection ? document.getText(editor.selection) : document.getText();
  const maxContextLength = 12_000;
  return JSON.stringify({
    path: vscode.workspace.asRelativePath(document.uri, false),
    language: document.languageId,
    scope: hasSelection ? "selection" : "file",
    truncated: text.length > maxContextLength,
    content: text.slice(0, maxContextLength),
  });
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
