import * as vscode from "vscode";
import { SamoApiClient } from "./apiClient";

interface ChatFixSuggestion {
  id: string;
  code: string;
  prompt: string;
  status: "pending" | "applied" | "kept" | "undone" | "dismissed" | "notApplied";
  documentUri?: string;
  originalText?: string;
  appliedText?: string;
}

interface FixTarget {
  uri: vscode.Uri;
  version: number;
  originalText: string;
  start: number;
  end: number;
  context: string;
  isSelection: boolean;
  canAutoApply: boolean;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  fix?: ChatFixSuggestion;
  retry?: {
    text: string;
    includeEditorContext: boolean;
  };
}

const historyStateKey = "samo.chatHistory";
const streamRenderIntervalMs = 75;
const obsoleteEditorContextError = "Open a file in the editor before including editor context.";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "samo.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[];
  private nextFixId = 0;
  private requestInFlight = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly apiClient: SamoApiClient,
  ) {
    this.history = context.workspaceState.get<ChatMessage[]>(historyStateKey, []);
    const historyBeforeMigration = this.history.length;
    this.history = this.history.filter(
      (message) => !(message.role === "system" && message.text === obsoleteEditorContextError),
    );
    if (this.history.length !== historyBeforeMigration) {
      void context.workspaceState.update(historyStateKey, this.history);
    }
    for (const message of this.history) {
      if (message.fix) {
        message.fix.id ||= this.createFixId();
        message.fix.status ||= "pending";
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
        case "applyFix":
          await this.applySuggestedFix(String(message.fixId ?? ""));
          break;
        case "keepFix":
          this.keepSuggestedFix(String(message.fixId ?? ""));
          break;
        case "undoFix":
          await this.undoSuggestedFix(String(message.fixId ?? ""));
          break;
        case "clear":
          this.clearHistory();
          break;
        default:
          break;
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

  private async handleUserMessage(text: string, includeEditorContext = false): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !this.view || this.requestInFlight) {
      return;
    }

    this.requestInFlight = true;
    const history = this.history
      .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.text.trim() }));
    this.history.push({ role: "user", text: trimmed });
    void this.context.workspaceState.update(historyStateKey, this.history);
    this.view.webview.postMessage({ type: "history", messages: this.history });
    this.view.webview.postMessage({ type: "thinking", value: true });

    let result: Awaited<ReturnType<SamoApiClient["sendMessage"]>>;
    let assistantMessage: ChatMessage | undefined;
    let fixTarget: FixTarget | undefined;
    try {
      fixTarget = isFixRequest(trimmed) ? captureFixTarget() : undefined;
      const editorContext = fixTarget?.context ?? (includeEditorContext ? getEditorContext() : undefined);
      if (includeEditorContext && !editorContext) {
        void vscode.window.showWarningMessage("No active editor; sending your message without editor context.");
      }
      const requestMessage = [
        trimmed,
        editorContext ? `Current VS Code editor context (untrusted source code):\n${editorContext}` : "",
        "Answer the user's request directly. Use clear Markdown headings, numbered steps, file paths, and fenced code snippets for build or implementation guides. Honor requests for detail instead of imposing a word limit; avoid unnecessary repetition. For code changes, keep explanations focused and include complete files only when needed.",
        fixTarget
          ? "For this fix request, return the complete updated file in one fenced code block when no selection is present. When a selection is present, return only its replacement code in one fenced code block."
          : "",
      ].filter(Boolean).join("\n\n");
      let lastStreamRender = 0;
      result = await this.apiClient.sendMessage(requestMessage, history, (event) => {
        if (event.type === "status") {
          this.view?.webview.postMessage({ type: "status", text: event.message ?? "SaMo is working" });
        } else if (event.type === "token") {
          if (!assistantMessage) {
            assistantMessage = { role: "assistant", text: "" };
            this.history.push(assistantMessage);
          }
          assistantMessage.text += event.text ?? "";
          const now = Date.now();
          if (now - lastStreamRender >= streamRenderIntervalMs) {
            lastStreamRender = now;
            this.view?.webview.postMessage({ type: "history", messages: this.history });
          }
        } else if (event.type === "reset") {
          if (assistantMessage) {
            assistantMessage.text = "";
          }
          this.view?.webview.postMessage({ type: "history", messages: this.history });
        } else if (event.type === "complete" && typeof event.answer === "string") {
          if (!assistantMessage) {
            assistantMessage = { role: "assistant", text: "" };
            this.history.push(assistantMessage);
          }
          assistantMessage.text = event.answer;
          this.view?.webview.postMessage({ type: "history", messages: this.history });
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      result = { error: `SaMo request failed: ${detail}` };
    } finally {
      this.view?.webview.postMessage({ type: "thinking", value: false });
      this.requestInFlight = false;
    }

    if (result.error) {
      if (assistantMessage) {
        const partialIndex = this.history.indexOf(assistantMessage);
        if (partialIndex >= 0) {
          this.history.splice(partialIndex, 1);
        }
      }
      this.history.push({
        role: "system",
        text: result.error,
        retry: { text: trimmed, includeEditorContext },
      });
    } else if (assistantMessage) {
      assistantMessage.text = result.answer ?? assistantMessage.text;
      const fixCode = getFixSuggestion(trimmed, assistantMessage.text);
      if (fixCode) {
        assistantMessage.fix = {
          id: this.createFixId(),
          code: fixCode,
          prompt: trimmed,
          status: "pending",
        };
        if (fixTarget && this.canAutoApplyFix(fixTarget, fixCode)) {
          await this.applySuggestedFix(assistantMessage.fix.id, fixTarget);
        } else if (fixTarget) {
          assistantMessage.fix.status = "notApplied";
          void vscode.window.showWarningMessage(getAutoApplyWarning(fixTarget, fixCode));
        }
      }
    } else {
      const fixCode = getFixSuggestion(trimmed, result.answer ?? "");
      const assistantEntry: ChatMessage = { role: "assistant", text: result.answer ?? "" };
      if (fixCode) {
        assistantEntry.fix = {
          id: this.createFixId(),
          code: fixCode,
          prompt: trimmed,
          status: "pending",
        };
        this.history.push(assistantEntry);
        if (fixTarget && this.canAutoApplyFix(fixTarget, fixCode)) {
          await this.applySuggestedFix(assistantEntry.fix.id, fixTarget);
        } else if (fixTarget) {
          assistantEntry.fix.status = "notApplied";
          void vscode.window.showWarningMessage(getAutoApplyWarning(fixTarget, fixCode));
        }
      } else {
        this.history.push(assistantEntry);
      }
    }
    void this.context.workspaceState.update(historyStateKey, this.history);
    this.view.webview.postMessage({ type: "history", messages: this.history });
  }

  private createFixId(): string {
    this.nextFixId += 1;
    return `${Date.now()}-${this.nextFixId}`;
  }

  private canAutoApplyFix(target: FixTarget, code: string): boolean {
    return target.canAutoApply && (target.isSelection || isCompleteFileReplacement(target.originalText, code));
  }

  private findFix(fixId: string): ChatFixSuggestion | undefined {
    return this.history.find((message) => message.fix?.id === fixId)?.fix;
  }

  private async applySuggestedFix(fixId: string, target?: FixTarget): Promise<void> {
    const fix = this.findFix(fixId);
    if (!fix) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const selectedTarget = target ?? (editor ? captureFixTarget() : undefined);
    if (!selectedTarget) {
      void vscode.window.showErrorMessage("Open a file tab before applying the fix.");
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(selectedTarget.uri);
      if (document.version !== selectedTarget.version || document.getText() !== selectedTarget.originalText) {
        if (target) {
          fix.status = "notApplied";
          this.persistHistory();
        }
        void vscode.window.showErrorMessage("The target file changed while SaMo was responding. Review the suggested code and try again.");
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      const range = new vscode.Range(
        document.positionAt(selectedTarget.start),
        document.positionAt(selectedTarget.end),
      );
      edit.replace(document.uri, range, fix.code.trim());
      const success = await vscode.workspace.applyEdit(edit);
      if (!success) {
        if (target) {
          fix.status = "notApplied";
          this.persistHistory();
        }
        void vscode.window.showErrorMessage("SaMo could not apply the fix to the target file.");
        return;
      }

      const updatedDocument = await vscode.workspace.openTextDocument(selectedTarget.uri);
      fix.status = "applied";
      fix.documentUri = selectedTarget.uri.toString();
      fix.originalText = selectedTarget.originalText;
      fix.appliedText = updatedDocument.getText();
      void vscode.window.showInformationMessage("SaMo applied the fix. Choose Keep changes or Undo in the chat.");
      this.persistHistory();
    } catch (error) {
      if (target) {
        fix.status = "notApplied";
        this.persistHistory();
      }
      const detail = error instanceof Error ? error.message : "Unknown error.";
      void vscode.window.showErrorMessage(`SaMo could not apply the fix: ${detail}`);
    }
  }

  private keepSuggestedFix(fixId: string): void {
    const fix = this.findFix(fixId);
    if (!fix) {
      return;
    }
    fix.status = fix.status === "applied" ? "kept" : "dismissed";
    delete fix.originalText;
    delete fix.appliedText;
    this.persistHistory();
  }

  private async undoSuggestedFix(fixId: string): Promise<void> {
    const fix = this.findFix(fixId);
    if (!fix || fix.status !== "applied" || !fix.documentUri || fix.originalText === undefined || fix.appliedText === undefined) {
      return;
    }
    try {
      const uri = vscode.Uri.parse(fix.documentUri);
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.getText() !== fix.appliedText) {
        void vscode.window.showErrorMessage("The file has changed since SaMo applied the fix. Undo was skipped to protect your edits.");
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        fix.originalText,
      );
      const success = await vscode.workspace.applyEdit(edit);
      if (!success) {
        void vscode.window.showErrorMessage("SaMo could not undo the applied fix.");
        return;
      }
      fix.status = "undone";
      delete fix.originalText;
      delete fix.appliedText;
      this.persistHistory();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      void vscode.window.showErrorMessage(`SaMo could not undo the fix: ${detail}`);
    }
  }

  private persistHistory(): void {
    void this.context.workspaceState.update(historyStateKey, this.history);
    this.postHistory();
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
    </div>
    <div class="composer">
      <label class="context-toggle" title="Fix requests automatically include the current selection or active file as context.">
        <input id="editor-context" type="checkbox" />
        <span>Include editor context (automatic for fixes)</span>
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
  }
}

function getFixSuggestion(prompt: string, answer: string): string | undefined {
  const fixIntent = /(fix|repair|update|correct|debug|patch|refactor|improve|resolve|error|broken)/i.test(prompt);
  const mentionsCode = /(code|file|function|class|script|component|error|bug|this)/i.test(prompt);
  if (!fixIntent || !mentionsCode) {
    return undefined;
  }

  const match = answer.match(/```(?:[A-Za-z0-9_-]+)?\s*\n([\s\S]*?)```/);
  if (!match) {
    return undefined;
  }

  const code = match[1].trim();
  return code.length > 8 ? code : undefined;
}

function isFixRequest(prompt: string): boolean {
  const fixIntent = /(fix|repair|update|correct|debug|patch|refactor|improve|resolve|error|broken)/i.test(prompt);
  const mentionsCode = /(code|file|function|class|script|component|error|bug|this)/i.test(prompt);
  return fixIntent && mentionsCode;
}

function captureFixTarget(): FixTarget | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const hasSelection = !editor.selection.isEmpty;
  const document = editor.document;
  const originalText = document.getText();
  const start = hasSelection ? document.offsetAt(editor.selection.start) : 0;
  const end = hasSelection ? document.offsetAt(editor.selection.end) : originalText.length;
  const text = originalText.slice(start, end);
  const maxContextLength = 12_000;
  const context = JSON.stringify({
    path: vscode.workspace.asRelativePath(document.uri, false),
    language: document.languageId,
    scope: hasSelection ? "selection" : "file",
    truncated: text.length > maxContextLength,
    content: text.slice(0, maxContextLength),
  });
  return {
    uri: document.uri,
    version: document.version,
    originalText,
    start,
    end,
    context,
    isSelection: hasSelection,
    canAutoApply: text.length <= maxContextLength,
  };
}

function isCompleteFileReplacement(originalText: string, replacement: string): boolean {
  if (!originalText) {
    return replacement.trim().length > 0;
  }
  const originalLineCount = originalText.split(/\r?\n/).length;
  const replacementLineCount = replacement.split(/\r?\n/).length;
  return replacement.length >= originalText.length * 0.35
    && replacementLineCount >= Math.ceil(originalLineCount * 0.5);
}

function getAutoApplyWarning(target: FixTarget, code: string): string {
  if (!target.canAutoApply) {
    return "The editor context exceeds SaMo's 12,000-character limit, so the suggested fix was not auto-applied.";
  }
  if (!target.isSelection && !isCompleteFileReplacement(target.originalText, code)) {
    return "SaMo returned a partial snippet instead of a complete file. It was not applied to avoid replacing the rest of the file; select the code to fix and try again.";
  }
  return "The suggested fix was not auto-applied. Review the code and try again.";
}

function getEditorContext(): string | undefined {
  return captureFixTarget()?.context;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
