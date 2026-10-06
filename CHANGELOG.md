# Change Log

## 0.4.1

- Branding: new black-and-white SaMo logo for the marketplace icon, Activity Bar icon (theme-aware), chat header, assistant avatars and the empty state.

## 0.4.0

- Expert persona: SaMo now reasons as a senior architect, reads code line by line, and finds root causes.
- Inline autocomplete: ghost-text suggestions while you type (`samo.autocomplete.enabled`).
- Easier-to-read inline edits: stronger green/red highlights with a left bar, uppercase KEEP / UNDO lenses, and a larger CodeLens font (`samo.inlineEdit.enlargeCodeLens`).

## 0.3.1

- Screenshots are now read locally with OCR (Tesseract, bundled, works offline) and only the extracted text is sent to the SaMo API, so no vision model or API change is needed. The text then goes through the normal fix / feature flow.

## 0.3.0

- Attach screenshots: use the 📎 button, paste (Cmd/Ctrl+V) or drag images into the composer. SaMo reads text, errors and UI problems from them and uses that to answer or fix code.
- Changes made across files are now highlighted in the editor with Keep / Undo buttons above each edited block, like Copilot edits.

## 0.2.4

- Short fix/edit requests with code selected now edit the selection directly in the file, with Keep / Undo CodeLens buttons above every changed block (plus Keep all / Undo all).
- Fixed assistant messages rendering one character per line when action buttons were shown.

## 0.2.3

- Dropped connections (`UND_ERR_SOCKET`, resets) are retried twice automatically before an error is shown.

## 0.2.2

- Composer shows a pinned chip for the selected lines (e.g. `apiClient.ts:3-20`); the selection is sent to SaMo automatically. Click the chip to attach the whole file, × to remove.
- A `N Files +added -removed` summary chip appears above the composer while changes are pending.

## 0.2.1

- Project audit: "check my project for issues/errors" now reads the workspace line by line, includes VS Code diagnostics, runs the type check and tests, and returns a severity-ordered report; say "fix these issues" to fix them.
- Raw `<tool_call>` text leaked by the service is detected and retried instead of being shown.

## 0.2.0

- Task lists: code requests are analyzed, split into ordered tasks, and executed one by one with a live ✅/⏳/❌ checklist, then verified with regression tests.
- Error fixing: pasted console errors or stack traces are detected, mapped to workspace files, root-caused, fixed, and re-tested automatically.
- Agent mode: SaMo detects code-change requests, returns structured JSON, and creates, edits, and deletes multiple files through `WorkspaceEdit`, with workspace-bound path validation, snapshots, Undo, and Keep.
- Regression tests: after applying changes SaMo runs the detected test command and automatically fixes failures (`samo.runTests`, `samo.maxFixIterations`).
- Understand mode: reads the workspace or a named file/folder line by line and stores a project model used for later development (`samo.maxUnderstandFiles`).
- Review and PR: "Review my changes" revises the Git diff; "Create PR" branches, commits, pushes, and opens a pull request via the GitHub CLI.
- Workspace file tree and relevant editor context are sent with requests.

## 0.1.8

- Report errors returned by the SaMo API with the service-provided detail instead of labeling them as incomplete streams.
- Honor requests for detailed, step-by-step guides with file paths and code snippets.

## 0.1.7

- Render formatted Markdown in chat responses and add copy buttons to fenced code blocks.

## 0.1.6

- Remove the obsolete editor-context error from saved conversations.
- Make the response inactivity timeout configurable from 15 to 300 seconds (120 seconds by default).
- Clarify timeout errors with likely causes and retry guidance.

## 0.1.3

- Add optional editor context to chat requests, using the active selection or file with a 12,000-character limit.

## 0.1.1

- Show clear errors when SaMo requests fail or time out, and identify older empty replies.

## 0.1.0

- Initial release: chat view for SaMo backed by the deployed SaMo HTTP API.
