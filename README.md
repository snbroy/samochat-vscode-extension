<p align="center"><img src="media/icon.png" alt="SaMo logo" width="96"></p>

# SaMo Chat

Chat with **SaMo**, an AI-powered Shopify engineering assistant, directly inside VS Code — in a ChatGPT/Copilot-style panel.

Developed by **Sanjib Roy**.

## Features

- Dedicated **SaMo** chat view in the Activity Bar with a familiar chat-bubble UI (user/assistant messages, typing indicator, rich Markdown responses, and copyable code blocks).
- Assistant responses render headings, bold and italic text, lists, tables, links, inline code, and fenced code blocks; raw HTML in responses is disabled.
- Optional editor context: include the selected code, or the active file when there is no selection, with a message. Context is off by default and limited to 12,000 characters. If context is enabled without an active editor, the message is sent without context and VS Code displays a warning.
- Requests ask SaMo to keep answers concise and direct; actual response length depends on the configured API.
- Code-fix requests automatically include the active selection or file as context. When SaMo returns a fenced code fix, the extension applies it to that selection or file and offers **Keep changes** or **Undo** in the chat. For whole-file fixes, partial snippets are not applied over the entire file. Fixes are also not auto-applied if the target changes while SaMo is responding or the context exceeds 12,000 characters.
- Conversation history persisted per workspace.
- Talks to your deployed SaMo API (`POST /api/chat`) using a securely stored access token.
- Failed requests show actionable connection or HTTP errors and a **Retry** action. Retries are user-triggered to avoid silently sending a duplicate chat request.
- If SaMo sends no response data, requests time out after 120 seconds by default. Set `samo.requestTimeoutSeconds` to adjust this between 15 and 300 seconds.

## Setup

1. Run **SaMo: Set Access Token** from the Command Palette and paste the access token issued by the SaMo administrator. It is stored in VS Code's encrypted SecretStorage, never in settings.
2. Open **Settings** and set:
   - `samo.apiUrl` — your deployed SaMo API base URL (e.g. `https://your-railway-domain`).
   - `samo.email` — the email address SaMo should record with your chat requests.
3. Click the SaMo icon in the Activity Bar and start chatting.

## Commands

| Command | Description |
| --- | --- |
| `SaMo: Open Chat` | Reveals the SaMo chat view. |
| `SaMo: Set Access Token` | Stores your SaMo access token securely. |
| `SaMo: Clear Chat History` | Clears the current conversation. |

## Privacy

This extension sends the message you type, conversation history, and configured email to the SaMo API you configure. If **Include editor context** is enabled, it also sends the selected code or active file content (up to 12,000 characters), its workspace-relative path, and language ID. Code-fix requests send that same editor context automatically when an editor is open so SaMo can produce a targeted fix. No data is sent anywhere else.

## Publishing (maintainer notes)

```sh
npm install
npm run build
npx vsce package   # produces samo-chat-<version>.vsix
npx vsce login devsanjib
npx vsce publish
```
