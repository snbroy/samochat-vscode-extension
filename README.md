<p align="center"><img src="media/icon.png" alt="SaMo logo" width="96"></p>

# SaMo Chat

**SaMo Chat** is a general-purpose AI assistant in Visual Studio Code for everyday questions and software development across programming languages, frameworks, and project types. Understand codebases, implement changes, investigate issues, run regression checks, and review work from one integrated workspace.

Designed for individual developers and teams who want a focused way to move from engineering task to verified change.

## Product capabilities

- **AI coding workflow:** ask questions, understand a project, develop features, debug, audit, and review code from the SaMo Activity Bar. Visual requests such as improving a footer, header, or layout are applied to project files, checked with available regression tests, and offered with Keep/Undo controls. When asked to inspect and fix project issues, SaMo applies evidence-based root-cause changes and re-runs available checks.
- **Iterative agent tools:** for coding work, SaMo can search and read workspace files, inspect definitions/references/call hierarchy/types and diagnostics, examine Git state, apply validated edits, and record verification evidence. The loop is bounded; it does not guarantee a particular response latency or correctness rate, which depend on the SaMo service and model.
- **Controlled code changes:** review proposed edits and choose to keep or undo them. SaMo uses SHA-256 preconditions to prevent stale overwrites, blocks protected paths and package-manager lockfiles, and keeps changes inside the workspace.
- **Regression checks:** SaMo can detect project scripts and run tests, type checks, lint, and build checks only after individual approval. When enabled, it can make bounded attempts to correct failures and re-run checks. Stop cancels active model requests and best-effort stops running commands.
- **Conversation continuity:** keep up to 50 conversations per workspace, start a fresh conversation, or return to saved work. Existing chat history is migrated automatically.
- **GitHub workflows:** review Git diffs and create pull requests using the GitHub CLI and the credentials already configured in your environment.
- **MCP integrations (opt-in):** connect user-configured stdio MCP servers in trusted workspaces. SaMo asks before starting each server and before every individual tool call, including calls selected by the bounded coding-agent loop.
- **Developer context:** optionally include the active selection or file (up to 12,000 characters). Code-fix requests include editor context automatically when an editor is open.
- **Account-based access:** connect to the SaMo VS Portal with an access token stored in VS Code's encrypted SecretStorage. The portal meters usage and routes requests to its configured model provider.
- **Task-aware inference:** casual conversation and code-generation requests use separate model sampling settings, while the portal applies SaMo's behavior, honesty, and security policy.
- **Clear request handling:** connection and HTTP errors include actionable details and a user-triggered retry. Requests time out after 120 seconds by default; configure `samo.requestTimeoutSeconds` from 15 to 300 seconds.

## Plans

Creating an account is free, but it does not include model requests. Paid plans are one-time purchases for 30 days and do not renew automatically. Usage credits are cost-weighted, and server-side inference budgets cap estimated model spend. Check the [SaMo VS Portal](https://vs.samotech.co.in) for current availability and account-specific plan information.

| Plan | API calls per 30-day cycle | Usage credits | Maximum planned inference spend | Listed price |
| --- | ---: | ---: | ---: | ---: |
| Account | 0 | 0 | ₹0 | ₹0 |
| Starter | 50 | 10 | ₹12.50 | ₹50 |
| Basic | 500 | 100 | ₹125 | ₹499 |
| Developer | 1,500 | 250 | ₹250 | ₹999 |
| Expert | 5,000 | 750 | ₹750 | ₹2,999 |
| Enterprise | Tailored for your team | Custom | Custom | Custom |

Enterprise plans can be tailored for team or business requirements. Contact [info@samotech.co.in](mailto:info@samotech.co.in) to discuss your needs.

## Get started

1. Create an account at [vs.samotech.co.in](https://vs.samotech.co.in) and copy the access token from your dashboard.
2. In VS Code, run **SaMo: Set Access Token** and paste the token. It is stored in encrypted SecretStorage, not in settings.
3. Set `samo.email` to the email address associated with your portal account. The default API endpoint is `https://vs.samotech.co.in`; change `samo.apiUrl` only if you use another SaMo-compatible service.
4. Open the **SaMo** icon in the Activity Bar and start working. Use **SaMo: Open Account Portal** to manage your account, usage, and plan.

## Commands

| Command | Description |
| --- | --- |
| `SaMo: Open Chat` | Opens the SaMo chat view. |
| `SaMo: Open Account Portal` | Opens your account, usage, and plan dashboard. |
| `SaMo: Set Access Token` | Stores your portal access token securely. |
| `SaMo: New Conversation` | Starts a separate workspace conversation. |
| `SaMo: Switch Conversation` | Reopens a saved workspace conversation. |
| `SaMo: Clear Chat History` | Clears the current conversation. |
| `SaMo: List MCP Tools` | Starts approved MCP servers and lists their available tools. |
| `SaMo: Run MCP Tool` | Selects a tool, collects JSON arguments, requests one-time approval, and displays the result. |

### MCP server setup

Configure `samo.mcp.servers` in VS Code **User Settings** (not workspace settings), for example:

```json
"samo.mcp.servers": [
  {
    "name": "example",
    "command": "npx",
    "args": ["-y", "some-mcp-server"]
  }
]
```

Use a trusted workspace. SaMo prompts before launching a configured executable and asks separately before each tool invocation. During coding tasks, SaMo can discover and propose configured MCP tools through its bounded agent loop; each proposed call still requires approval. Credentials should come from the server process's inherited environment rather than being placed in user settings; the extension passes only VS Code's safe inherited environment variables plus explicitly configured overrides. Tool arguments and results are not added to saved chat history.

## Privacy

SaMo sends your message, conversation history, and configured account email to the selected SaMo API endpoint (the SaMo VS Portal by default). When editor context is included, the selected code or active file content (up to 12,000 characters), workspace-relative path, and language identifier are also sent. Code-fix requests include available editor context automatically. Screenshot attachments are processed locally using OCR; only extracted text is sent to the API. The portal forwards chat content to its configured model provider. MCP server tool inputs and results stay local to the extension and server connection; they are not sent to the hosted model by the current manual command flow. Do not submit credentials, secrets, or code you are not authorized to share. Review the portal's privacy information before use.

## Business and support

For account, plan, team, or product support, email [info@samotech.co.in](mailto:info@samotech.co.in). Include your SaMo account email and a brief description of the issue; do not include access tokens, passwords, or private source code.

## Experimental model fine-tuning

The optional [training toolkit](https://github.com/snbroy/Samo-AI/tree/main/vscode-extension/training) contains a small behavior dataset, evaluation prompts, and a GPU LoRA starter. It is not shipped in the VS Code package, and SaMo has **not** been fine-tuned. The current hosted portal model is steered by an inference-time system prompt; creating a LoRA adapter requires training and deploying compatible model weights separately.

## Publishing (maintainer notes)

```sh
npm install
npm run build
npx vsce package   # produces samo-chat-<version>.vsix
npx vsce login devsanjib
npx vsce publish
```
