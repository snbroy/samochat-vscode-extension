import * as vscode from "vscode";
import { defaultApiUrl, SamoApiClient } from "./apiClient";
import { ChatViewProvider } from "./chatViewProvider";
import { InlineEditManager } from "./inlineEdit";
import { SamoCompletionProvider } from "./autocomplete";
import { McpClientManager } from "./mcpClient";

const secretKeyAccessToken = "samo.accessToken";
const maxMcpOutputCharacters = 60_000;

export function activate(context: vscode.ExtensionContext): void {
  const apiClient = new SamoApiClient(context, secretKeyAccessToken);
  const inlineEdits = new InlineEditManager();
  const mcp = new McpClientManager();
  const provider = new ChatViewProvider(context, apiClient, inlineEdits, mcp);
  const mcpOutput = vscode.window.createOutputChannel("SaMo MCP");

  context.subscriptions.push(
    inlineEdits,
    mcp,
    mcpOutput,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, new SamoCompletionProvider(apiClient)),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("samo.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.samo-chat-container");
    }),
    vscode.commands.registerCommand("samo.clearChat", () => {
      provider.clearHistory();
    }),
    vscode.commands.registerCommand("samo.newChat", () => {
      provider.startNewConversation();
      void vscode.commands.executeCommand("workbench.view.extension.samo-chat-container");
    }),
    vscode.commands.registerCommand("samo.switchConversation", async () => {
      const selected = await vscode.window.showQuickPick(provider.getConversationQuickPickItems(), {
        placeHolder: "Select a SaMo conversation to reopen",
      });
      if (selected) await provider.switchConversation(selected.id);
      void vscode.commands.executeCommand("workbench.view.extension.samo-chat-container");
    }),
    vscode.commands.registerCommand("samo.openAccountPortal", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(defaultApiUrl));
    }),
    vscode.commands.registerCommand("samo.setAccessToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "SaMo Access Token",
        prompt: "Paste the access token from your SaMo account portal.",
        password: true,
        ignoreFocusOut: true,
      });
      if (token && token.trim()) {
        await context.secrets.store(secretKeyAccessToken, token.trim());
        void vscode.window.showInformationMessage("SaMo access token saved.");
      }
    }),
    vscode.commands.registerCommand("samo.mcp.listTools", async () => {
      try {
        const tools = await mcp.listTools();
        mcpOutput.clear();
        mcpOutput.appendLine(tools.length
          ? `Available MCP tools (${tools.length}):`
          : "No MCP tools are available. Configure user-level samo.mcp.servers in Settings.");
        for (const tool of tools) {
          mcpOutput.appendLine(`\n${tool.server} · ${tool.name}`);
          if (tool.description) mcpOutput.appendLine(tool.description);
        }
        mcpOutput.show(true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown MCP error.";
        void vscode.window.showErrorMessage(`SaMo MCP: ${detail}`);
      }
    }),
    vscode.commands.registerCommand("samo.mcp.callTool", async () => {
      try {
        const tools = await mcp.listTools();
        if (!tools.length) {
          void vscode.window.showInformationMessage("No MCP tools are available. Configure samo.mcp.servers in user Settings.");
          return;
        }
        const selected = await vscode.window.showQuickPick(
          tools.map((tool) => ({
            label: `${tool.server} · ${tool.name}`,
            description: tool.description,
            tool,
          })),
          { placeHolder: "Select an MCP tool to run (approval is required for this call)" },
        );
        if (!selected) return;

        const rawArguments = await vscode.window.showInputBox({
          title: `${selected.tool.server} · ${selected.tool.name}`,
          prompt: "Tool arguments as a JSON object. Leave empty for {}.",
          value: "{}",
          ignoreFocusOut: true,
        });
        if (rawArguments === undefined) return;
        if (rawArguments.length > 32_000) throw new Error("MCP tool arguments exceed 32,000 characters.");
        const args: unknown = JSON.parse(rawArguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new Error("MCP tool arguments must be a JSON object.");
        }

        const result = await mcp.callTool(selected.tool.server, selected.tool.name, args as Record<string, unknown>);
        mcpOutput.clear();
        mcpOutput.appendLine(`${selected.tool.server} · ${selected.tool.name}${result.isError ? " (tool reported an error)" : ""}`);
        let remaining = maxMcpOutputCharacters;
        for (const item of result.content ?? []) {
          const text = item.type === "text" && item.text
            ? item.text
            : `[${item.type} result omitted from text output]`;
          if (remaining <= 0) break;
          const excerpt = text.slice(0, remaining);
          mcpOutput.appendLine(excerpt);
          remaining -= excerpt.length;
        }
        if (remaining <= 0) mcpOutput.appendLine("\n[Output truncated at 60,000 characters.]");
        mcpOutput.show(true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown MCP error.";
        void vscode.window.showErrorMessage(`SaMo MCP: ${detail}`);
      }
    }),
  );
}

export function deactivate(): void {}
