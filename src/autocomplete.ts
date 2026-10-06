import * as vscode from "vscode";
import { SamoApiClient } from "./apiClient";

const debounceMs = 600;
const maxPrefixChars = 3000;
const maxSuffixChars = 1000;
const cacheLimit = 50;

export function cleanCompletion(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");
  const fence = /```[\w+-]*\n([\s\S]*?)(```|$)/.exec(text);
  if (fence) {
    text = fence[1];
  }
  return text.replace(/\s+$/, "");
}

export class SamoCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, string>();

  constructor(private readonly api: SamoApiClient) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!vscode.workspace.getConfiguration("samo").get<boolean>("autocomplete.enabled", true)) {
      return undefined;
    }
    if (context.selectedCompletionInfo || document.uri.scheme === "output" || document.lineCount > 20000) {
      return undefined;
    }
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const prefixStart = document.offsetAt(position) - maxPrefixChars;
    const prefix = document.getText(new vscode.Range(document.positionAt(Math.max(0, prefixStart)), position));
    if (prefix.trim().length < 3) {
      return undefined;
    }
    const suffixEnd = document.offsetAt(position) + maxSuffixChars;
    const suffix = document.getText(new vscode.Range(position, document.positionAt(suffixEnd)));

    await new Promise((resolve) => setTimeout(resolve, debounceMs));
    if (token.isCancellationRequested) {
      return undefined;
    }

    const key = `${document.languageId}\n${prefix}\u0000${suffix.slice(0, 200)}`;
    let completion = this.cache.get(key);
    if (completion === undefined) {
      const prompt = [
        `You are SaMo's inline code completion engine for ${document.languageId}.`,
        "Continue the code at the <CURSOR> marker. Reply with ONLY the text to insert at the cursor: no explanation, no markdown fences, no repetition of existing code.",
        "Match the surrounding style, naming and indentation. Prefer completing the current statement or block; keep it short (at most ~10 lines). If nothing sensible should be inserted, reply with an empty message.",
        "",
        `File: ${vscode.workspace.asRelativePath(document.uri)}`,
        "<CODE>",
        `${prefix}<CURSOR>${suffix}`,
        "</CODE>",
      ].join("\n");
      try {
        const result = await this.api.sendMessage(prompt, []);
        if (token.isCancellationRequested || result.error || !result.answer) {
          return undefined;
        }
        completion = cleanCompletion(result.answer);
      } catch {
        return undefined;
      }
      if (this.cache.size >= cacheLimit) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      this.cache.set(key, completion);
    }
    if (!completion || completion.trim() === linePrefix.trim() || /^(sorry|i cannot|i can't)/i.test(completion)) {
      return undefined;
    }
    return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
  }
}
