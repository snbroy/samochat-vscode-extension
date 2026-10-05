# Change Log

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
