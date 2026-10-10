# SaMo production readiness and feature checklist

This checklist reflects the extension and portal source in this workspace. “Implemented”
means the feature exists in code; it does not imply a production deployment or service-level
guarantee. SaMo has useful coding-agent workflows, but it is not yet feature-equivalent to
GitHub Copilot or OpenAI Codex.

## Available in the extension

- [x] SaMo chat panel, Markdown rendering, streamed responses, retry, and per-workspace chat history.
- [x] Portal account token authentication; access tokens are stored in VS Code encrypted SecretStorage.
- [x] Workspace understanding, file/folder context selection, editor context, and project summaries.
- [x] Applicable `AGENTS.md`, Copilot instruction, GitHub instruction, and `SKILL.md` guidance included in coding context with user/safety precedence.
- [x] Multi-file create/edit/delete changes with workspace path and symlink containment checks, snapshots, Keep, and Undo.
- [x] Code fixes, error/stack-trace diagnosis, project audit, VS Code diagnostics, and task progress.
- [x] Detected test, typecheck, lint, and build commands; report each check and allow bounded automatic fixes in trusted workspaces.
- [x] Inline autocomplete and inline edit Keep/Undo controls.
- [x] Screenshot attachment with local OCR; extracted text, not the image, is sent to the model.
- [x] Git diff review and pull-request creation using the installed/authenticated Git and `gh` tools.
- [x] SaMo VS Portal as the default API endpoint; account and plan portal command.
- [x] Per-plan rolling-cycle quotas, SQLite-backed minute burst limits, refunds on pre-stream model failure, and administrator token/plan actions.

## Missing or not equivalent to Copilot/Codex

- [ ] A general model tool-call loop with user approval for arbitrary shell commands, terminal sessions, and iterative tool output. Current agent workflows are orchestrated by the extension and do not provide an unrestricted interactive terminal agent.
- [ ] Debug-adapter control (breakpoints, stepping, variable inspection) and browser/UI automation.
- [ ] Native VS Code Chat Participant/inline chat integration and first-party collaboration with other coding agents.
- [ ] User-selectable models/providers, model fallback, and transparent per-model token/cost controls.
- [ ] Cloud-synced conversation history, shared projects, team seats, role-based access, and enterprise SSO/policy controls.
- [ ] Durable semantic code indexing/retrieval for large repositories and incremental cross-session project memory. Current context is bounded and workspace-local.
- [ ] A production-tested agent approval/rollback workflow across crashes, extension reloads, and concurrent edits; current changes have local Keep/Undo snapshots.
- [ ] Usage analytics, invoice/receipt and refund administration, self-service account deletion/export, and a staffed support process.

## Required before public production launch

- [ ] Deploy the portal with persistent SQLite storage mounted at `/data`; test restart persistence and a backup restore.
- [ ] Put the portal source in a Git repository/monorepo or connect it to the deployment repository; this portal folder currently has no `.git` metadata and is not included in the extension repository.
- [ ] Set the required production secrets and verify startup fails when required configuration is absent. Never commit `.env` or secrets.
- [ ] Verify `https://vs.samotech.co.in`, DNS, TLS, `/health`, outbound Resend delivery, email link expiry, login, logout, token rotation/revocation, and Google OAuth redirect settings (if enabled).
- [ ] Run live-mode Razorpay end-to-end tests: order creation, captured-payment verification, webhook signature/idempotency, plan activation/expiry, duplicate and failed payments, and refunds. **Do not enable live checkout until payment settlement and refund handling are verified.**
- [ ] Document service limits, acceptable use, privacy/data retention, subscription terms, cancellation/refund rules, and support contact; obtain any required legal/tax review.
- [ ] Test rate limiting behind Railway's proxy, database contention under concurrent requests, provider timeouts/disconnects, quota refunds, and operational alerts/log retention.
- [ ] Package and install the VSIX on supported VS Code versions/OSes; verify bundled OCR assets, settings, activation, upgrade behavior, and clean uninstall.
- [ ] Set up marketplace publisher ownership, listing screenshots, support/privacy URLs, release notes, credential rotation, deployment rollback, and incident response.
- [ ] Run a security review and dependency/license audit before taking public payments.

## Release snapshot

- [x] Extension defaults to `https://vs.samotech.co.in`; custom compatible API URLs remain configurable.
- [x] Extension tests, build and VSIX packaging pass locally (38 tests; VSIX file-count performance warning remains).
- [x] Portal automated tests (21 tests), TypeScript type-check, and production build pass locally.
- [ ] External production credentials, live billing, domain deployment, legal documents, and marketplace publication remain owner-operated launch gates; they cannot be verified or completed from this source workspace.
