import * as vscode from "vscode";
import { SamoApiClient } from "./apiClient";
import { ChatViewProvider } from "./chatViewProvider";

const secretKeyAccessToken = "samo.accessToken";

export function activate(context: vscode.ExtensionContext): void {
  const apiClient = new SamoApiClient(context, secretKeyAccessToken);
  const provider = new ChatViewProvider(context, apiClient);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("samo.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.samo-chat-container");
    }),
    vscode.commands.registerCommand("samo.clearChat", () => {
      provider.clearHistory();
    }),
    vscode.commands.registerCommand("samo.setAccessToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "SaMo Access Token",
        prompt: "Enter the access token issued by the SaMo administrator.",
        password: true,
        ignoreFocusOut: true,
      });
      if (token && token.trim()) {
        await context.secrets.store(secretKeyAccessToken, token.trim());
        void vscode.window.showInformationMessage("SaMo access token saved.");
      }
    }),
  );
}

export function deactivate(): void {}
