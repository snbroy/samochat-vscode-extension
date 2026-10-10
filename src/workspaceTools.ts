import * as vscode from "vscode";
import * as path from "node:path";
import { z } from "zod";
import {
  extractErrorFiles,
  parseChangeSet,
  redactSecrets,
  resolveInsideRealRoot,
  type ChangeAction,
  type FileChange,
} from "./agentCore";
import {
  applyChanges,
  getFileDiff,
  getGitBranchStatus,
  getGitChangedFiles,
  getRecentCommits,
  getWorkspaceDiagnostics,
  listWorkspaceFiles,
  readWorkspaceText,
  readWorkspaceTextWithHash,
  resolveRegressionPlan,
  runTests,
  snapshotDiffStats,
  type Snapshot,
  type TestRun,
} from "./workspaceAgent";
import type { AgentTool } from "./agentLoop";

const emptyArgs = z.object({}).strict();
const fileArgs = z.object({ path: z.string().min(1).max(512) }).strict();
const searchArgs = z.object({ query: z.string().min(1).max(300) }).strict();
const referenceArgs = z.object({
  path: z.string().min(1).max(512),
  line: z.number().int().min(1),
  character: z.number().int().min(1).default(1),
}).strict();
const locationResult = z.array(z.object({
  path: z.string(),
  line: z.number().int(),
  character: z.number().int(),
  name: z.string().optional(),
}).strict()).max(100);
const callHierarchyArgs = referenceArgs.extend({
  direction: z.enum(["incoming", "outgoing"]),
});
const callHierarchyResult = z.array(z.object({
  name: z.string(),
  path: z.string(),
  line: z.number().int(),
  direction: z.enum(["incoming", "outgoing"]),
}).strict()).max(100);
const importGraphResult = z.object({
  edges: z.array(z.object({ from: z.string(), specifier: z.string(), resolved: z.string().optional() }).strict()).max(500),
  truncated: z.boolean(),
}).strict();
const stackTraceArgs = z.object({ trace: z.string().min(1).max(20_000) }).strict();
const inspectLocationArgs = z.object({
  path: z.string().min(1).max(512),
  line: z.number().int().min(1),
}).strict();
const inspectLocationResult = z.object({
  path: z.string(),
  line: z.number().int(),
  excerpt: z.string().max(8_000),
}).strict();
const typeInformationResult = z.object({
  hover: z.string().max(8_000),
  definitions: locationResult,
}).strict();
const errorLocationResult = z.array(inspectLocationResult).max(50);
const applyArgs = z.object({
  changeSet: z.record(z.string(), z.unknown()),
}).strict();
const fileListResult = z.array(z.string()).max(300);
const fileReadResult = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
const searchResult = z.object({
  matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() }).strict()).max(40),
  truncated: z.boolean(),
}).strict();
const referenceResult = z.array(z.object({
  path: z.string(),
  line: z.number().int(),
  character: z.number().int(),
}).strict()).max(100);
const diagnosticsResult = z.array(z.object({
  path: z.string(),
  line: z.number().int(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  source: z.string().optional(),
}).strict()).max(100);
const applyResult = z.object({
  applied: z.array(z.object({ path: z.string(), action: z.enum(["create", "modify", "delete"]) }).strict()),
  summary: z.string(),
  notes: z.string(),
}).strict();
const testsResult = z.union([
  z.object({ note: z.string(), tests: z.array(z.never()) }).strict(),
  z.object({
    tests: z.array(z.object({
      label: z.string(),
      passed: z.boolean(),
      output: z.string(),
    }).strict()).max(4),
  }).strict(),
]);
const commandListResult = z.array(z.object({
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  reason: z.string(),
}).strict()).max(4);
const gitFilesResult = z.object({
  files: z.array(z.object({ path: z.string(), status: z.string(), owner: z.enum(["samo", "pre-existing", "new-user-change"]) }).strict()).max(500),
  error: z.string().optional(),
}).strict();
const gitTextResult = z.object({ text: z.string().max(16_000), error: z.string().optional() }).strict();
const evidenceResult = z.object({ recorded: z.boolean(), count: z.number().int(), message: z.string() }).strict();
const planTaskSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  status: z.enum(["pending", "in_progress", "done", "blocked"]).default("pending"),
}).strict();
const planResult = z.object({ tasks: z.array(planTaskSchema).max(12) }).strict();
const createTaskArgs = z.object({
  steps: z.array(planTaskSchema.omit({ status: true })).min(1).max(12),
}).strict();
const evidenceArgs = z.object({
  claim: z.string().min(1).max(500),
  source: z.string().min(1).max(100),
  detail: z.string().min(1).max(2_000),
}).strict();
const acceptanceArgs = z.object({ criteria: z.array(z.string().min(1).max(500)).max(12) }).strict();
const acceptanceResult = z.array(z.object({
  criterion: z.string(),
  evidence: z.array(z.string()).max(8),
}).strict()).max(12);
const taskUpdateArgs = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(["pending", "in_progress", "done", "blocked"]),
}).strict();
const taskUpdateResult = z.object({
  updated: z.boolean(),
  tasks: z.array(planTaskSchema).max(12),
}).strict();
const taskSummaryResult = z.object({
  files: z.array(z.object({ path: z.string(), action: z.enum(["create", "modify", "delete"]) }).strict()).max(100),
  added: z.number().int(),
  removed: z.number().int(),
  summary: z.string(),
}).strict();
const compareResult = z.array(z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  before: z.string().max(2_000).optional(),
  after: z.string().max(2_000).optional(),
}).strict()).max(40);
const mcpSearchArgs = z.object({ query: z.string().min(1).max(300) }).strict();
const mcpSearchResult = z.array(z.object({
  server: z.string(),
  name: z.string(),
  description: z.string().max(1_000),
}).strict()).max(100);
const mcpCallArgs = z.object({
  server: z.string().min(1).max(64),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
}).strict();
const documentationArgs = z.object({
  server: z.string().min(1).max(64),
  tool: z.string().min(1).max(128),
  query: z.string().min(1).max(2_000),
}).strict();
const documentationResult = z.object({
  text: z.string().max(12_000),
  isError: z.boolean(),
}).strict();

interface McpToolsBridge {
  listTools(signal?: AbortSignal): Promise<Array<{ server: string; name: string; description: string; inputSchema: Record<string, unknown> }>>;
  callTool(server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

export interface WorkspaceToolOptions {
  root: string;
  snapshot: Snapshot;
  touched: Map<string, ChangeAction>;
  onChangesApplied(changes: FileChange[], summary: string, notes: string): void;
  confirmDelete(paths: string[]): Promise<boolean>;
  confirmTests(commands: string[]): Promise<boolean>;
  initialGitFiles?: string[];
  mcp?: McpToolsBridge;
}

function mergeTouched(touched: Map<string, ChangeAction>, changes: Array<{ path: string; action: ChangeAction }>): void {
  for (const change of changes) {
    const previous = touched.get(change.path);
    touched.set(change.path, previous === "create" && change.action === "modify" ? "create" : change.action);
  }
}

async function searchWorkspace(root: string, query: string): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  const files = await listWorkspaceFiles(root, 500);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const needle = query.toLocaleLowerCase();
  for (const file of files) {
    const content = await readWorkspaceText(root, file, 30_000);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      if (!text.toLocaleLowerCase().includes(needle)) continue;
      matches.push({ path: file, line: index + 1, text: redactSecrets(text).slice(0, 500) });
      if (matches.length >= 40) return { matches, truncated: true };
    }
  }
  return { matches, truncated: files.length >= 500 };
}

    async function openPosition(
      root: string,
      args: z.infer<typeof referenceArgs>,
    ): Promise<{ document: vscode.TextDocument; position: vscode.Position }> {
      const absolute = await resolveInsideRealRoot(root, args.path);
      if (!absolute) throw new Error(`Path "${args.path}" is outside the workspace or resolves through an unsafe symlink.`);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      if (args.line > document.lineCount || args.character > document.lineAt(args.line - 1).text.length + 1) {
        throw new Error("The requested symbol position is outside the document.");
      }
      return { document, position: new vscode.Position(args.line - 1, args.character - 1) };
    }

    function workspaceRelativePath(uri: vscode.Uri): string {
      return vscode.workspace.getWorkspaceFolder(uri)
        ? vscode.workspace.asRelativePath(uri, false)
        : "[external dependency]";
    }

    async function findReferences(root: string, args: z.infer<typeof referenceArgs>): Promise<unknown> {
      const { document, position } = await openPosition(root, args);
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        document.uri,
        position,
      );
      if (!references) throw new Error("No language server provided reference results for this symbol.");
      return references.slice(0, 100).map((reference) => ({
        path: workspaceRelativePath(reference.uri),
        line: reference.range.start.line + 1,
        character: reference.range.start.character + 1,
      }));
    }

    async function getDefinitions(root: string, args: z.infer<typeof referenceArgs>): Promise<unknown> {
      const { document, position } = await openPosition(root, args);
      const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        "vscode.executeDefinitionProvider",
        document.uri,
        position,
      );
      if (!definitions) throw new Error("No language server provided a definition for this symbol.");
      return definitions.slice(0, 100).map((definition) => {
        const uri = "targetUri" in definition ? definition.targetUri : definition.uri;
        const range = "targetUri" in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
        return {
          path: workspaceRelativePath(uri),
          line: range.start.line + 1,
          character: range.start.character + 1,
        };
      });
    }

    async function getTypeInformation(root: string, args: z.infer<typeof referenceArgs>): Promise<unknown> {
      const { document, position } = await openPosition(root, args);
      const [hovers, typeDefinitions] = await Promise.all([
        vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, position),
        vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
          "vscode.executeTypeDefinitionProvider",
          document.uri,
          position,
        ),
      ]);
      const hover = (hovers ?? []).flatMap((entry) => entry.contents)
        .map((content) => typeof content === "string" ? content : content.value)
        .join("\n")
        .slice(0, 8_000);
      const definitions = (typeDefinitions ?? []).slice(0, 50).map((definition) => {
        const uri = "targetUri" in definition ? definition.targetUri : definition.uri;
        const range = "targetUri" in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
        return { path: workspaceRelativePath(uri), line: range.start.line + 1, character: range.start.character + 1 };
      });
      if (!hover && !definitions.length) throw new Error("No language server provided hover or type-definition information.");
      return { hover: redactSecrets(hover), definitions };
    }

    async function getCallHierarchy(root: string, args: z.infer<typeof callHierarchyArgs>): Promise<unknown> {
      const { document, position } = await openPosition(root, args);
      const prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem | vscode.CallHierarchyItem[]>(
        "vscode.prepareCallHierarchy",
        document.uri,
        position,
      );
      const item = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!item) throw new Error("No language server prepared a call hierarchy for this symbol.");
      if (args.direction === "incoming") {
        const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
          "vscode.provideIncomingCalls",
          item,
        );
        return (calls ?? []).slice(0, 100).map((call) => ({
          name: call.from.name,
          path: workspaceRelativePath(call.from.uri),
          line: call.from.range.start.line + 1,
          direction: "incoming",
        }));
      }
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        "vscode.provideOutgoingCalls",
        item,
      );
      return (calls ?? []).slice(0, 100).map((call) => ({
        name: call.to.name,
        path: workspaceRelativePath(call.to.uri),
        line: call.to.range.start.line + 1,
        direction: "outgoing",
      }));
    }

    async function getImportGraph(root: string): Promise<{ edges: Array<{ from: string; specifier: string; resolved?: string }>; truncated: boolean }> {
      const files = await listWorkspaceFiles(root, 500);
      const known = new Set(files);
      const edges: Array<{ from: string; specifier: string; resolved?: string }> = [];
      const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^\n;]*?\s+from\s+)?["']([^"']+)["']|\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
      for (const file of files) {
        const content = await readWorkspaceText(root, file, 30_000);
        if (content === undefined) continue;
        importPattern.lastIndex = 0;
        for (const match of content.matchAll(importPattern)) {
          const specifier = match[1] ?? match[2];
          let resolved: string | undefined;
          if (specifier.startsWith(".")) {
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
            resolved = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((ext) => `${base}${ext}`)]
              .find((candidate) => known.has(candidate));
          }
          edges.push({ from: file, specifier: redactSecrets(specifier), ...(resolved ? { resolved } : {}) });
          if (edges.length >= 500) return { edges, truncated: true };
        }
      }
      return { edges, truncated: files.length >= 500 };
    }

    async function inspectLocation(root: string, args: z.infer<typeof inspectLocationArgs>): Promise<unknown> {
      const absolute = await resolveInsideRealRoot(root, args.path);
      if (!absolute) throw new Error(`Path "${args.path}" is outside the workspace or resolves through an unsafe symlink.`);
      const text = await readWorkspaceText(root, args.path, 100_000);
      if (text === undefined) throw new Error(`Could not read "${args.path}" as a text file.`);
      const lines = text.split(/\r?\n/);
      if (args.line > lines.length) throw new Error(`Line ${args.line} is outside "${args.path}".`);
      const first = Math.max(0, args.line - 6);
      const last = Math.min(lines.length, args.line + 5);
      return {
        path: args.path,
        line: args.line,
        excerpt: lines.slice(first, last).map((line, index) => `${first + index + 1}${first + index + 1 === args.line ? ">" : "|"} ${line}`).join("\n"),
      };
    }

    async function runDetectedChecks(
      root: string,
      options: WorkspaceToolOptions,
      signal: AbortSignal | undefined,
      kinds: string[],
      exactLabel?: string,
    ): Promise<unknown> {
      if (!vscode.workspace.isTrusted) throw new Error("Project commands cannot run until this workspace is trusted.");
      if (signal?.aborted) throw new Error("Project command execution was cancelled.");
      const files = await listWorkspaceFiles(root);
      const plan = await resolveRegressionPlan(root, files);
      const selected = plan.filter((step) => kinds.some((kind) => step.label.toLowerCase().includes(kind))
        && (!exactLabel || step.label === exactLabel)).slice(0, 4);
      if (!selected.length) return { note: exactLabel ? `Detected command "${exactLabel}" was not available to rerun.` : "No matching project command was detected.", tests: [] };
      const tests: TestRun[] = [];
      for (const step of selected) {
        if (signal?.aborted) throw new Error("Project command execution was cancelled.");
        const command = `${step.command} ${step.args.join(" ")}`.trim();
        if (!(await options.confirmTests([`${step.label}: ${command}`]))) {
          throw new Error(`Running ${step.label} was not approved.`);
        }
        if (signal?.aborted) throw new Error("Project command execution was cancelled.");
        tests.push(await runTests(root, { command: step.command, args: step.args, label: step.label }, 120_000, signal));
      }
      return { tests: tests.map((test) => ({ label: test.label, passed: test.passed, output: redactSecrets(test.output).slice(-4_000) })) };
    }

    function formatMcpContent(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): { text: string; isError: boolean } {
      const text = (result.content ?? []).map((item) => item.type === "text" ? item.text ?? "" : `[${item.type} content omitted]`).join("\n");
      return { text: redactSecrets(text).slice(0, 12_000), isError: Boolean(result.isError) };
    }

    function documentedToolArguments(inputSchema: Record<string, unknown>, keyCandidates: string[], value: string): Record<string, unknown> {
      const properties = inputSchema.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        throw new Error("The configured MCP documentation tool has no usable JSON Schema properties.");
      }
      const key = keyCandidates.find((candidate) => Object.hasOwn(properties, candidate));
      if (!key) throw new Error("The configured MCP documentation tool has no recognized query or URL argument.");
      const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((item): item is string => typeof item === "string") : [];
      if (required.some((requiredKey) => requiredKey !== key)) {
        throw new Error("The configured MCP documentation tool requires additional arguments; call it directly using call_approved_mcp_tool.");
      }
      return { [key]: value };
    }

export function createWorkspaceTools(options: WorkspaceToolOptions): AgentTool[] {
  const { root, snapshot, touched } = options;
  const initialGitFiles = new Set(options.initialGitFiles ?? []);
  let tasks: Array<z.infer<typeof planTaskSchema>> = [];
  const evidence: string[] = [];
  const tools: AgentTool[] = [
    {
      name: "list_files",
      description: "List workspace file paths (generated and dependency directories are excluded).",
      argumentSchema: emptyArgs,
      resultSchema: fileListResult,
      execute: async () => (await listWorkspaceFiles(root, 500)).slice(0, 300),
    },
    {
      name: "read_file",
      description: "Read a workspace file and return its current SHA-256 hash for safe change proposals.",
      argumentSchema: fileArgs,
      resultSchema: fileReadResult,
      execute: async ({ path: file }) => {
        const content = await readWorkspaceTextWithHash(root, file, 30_000);
        if (!content) throw new Error(`Could not read "${file}" as a text file inside this workspace.`);
        return { path: file, content: redactSecrets(content.content), sha256: content.sha256 };
      },
    },
    {
      name: "search_workspace",
      description: "Search workspace source files for exact text and return bounded matching lines.",
      argumentSchema: searchArgs,
      resultSchema: searchResult,
      execute: ({ query }) => searchWorkspace(root, query),
    },
    {
      name: "find_references",
      description: "Use the active language server to find references to the symbol at a file position.",
      argumentSchema: referenceArgs,
      resultSchema: referenceResult,
      execute: (args) => findReferences(root, referenceArgs.parse(args)),
    },
    {
      name: "get_definition",
      description: "Resolve a symbol definition using VS Code's active language server.",
      argumentSchema: referenceArgs,
      resultSchema: locationResult,
      execute: (args) => getDefinitions(root, referenceArgs.parse(args)),
    },
    {
      name: "get_call_hierarchy",
      description: "Find incoming or outgoing calls for a symbol using VS Code's active language server.",
      argumentSchema: callHierarchyArgs,
      resultSchema: callHierarchyResult,
      execute: (args) => getCallHierarchy(root, callHierarchyArgs.parse(args)),
    },
    {
      name: "get_type_information",
      description: "Read language-server hover/type information and type definitions at a file position.",
      argumentSchema: referenceArgs,
      resultSchema: typeInformationResult,
      execute: (args) => getTypeInformation(root, referenceArgs.parse(args)),
    },
    {
      name: "get_import_graph",
      description: "Build a bounded static graph of literal import/require specifiers; unresolved aliases and dynamic expressions are not inferred.",
      argumentSchema: emptyArgs,
      resultSchema: importGraphResult,
      execute: () => getImportGraph(root),
    },
    {
      name: "get_diagnostics",
      description: "Return current VS Code diagnostics for files in this workspace.",
      argumentSchema: emptyArgs,
      resultSchema: diagnosticsResult,
      execute: async () => getWorkspaceDiagnostics(root, 100).map((diagnostic) => ({
        ...diagnostic,
        message: redactSecrets(diagnostic.message).slice(0, 1_000),
      })),
    },
    {
      name: "inspect_error_location",
      description: "Read a bounded, line-numbered source excerpt around a compiler or runtime error location.",
      argumentSchema: inspectLocationArgs,
      resultSchema: inspectLocationResult,
      execute: (args) => inspectLocation(root, inspectLocationArgs.parse(args)),
    },
    {
      name: "get_stack_trace",
      description: "Resolve workspace file/line locations in a stack trace and read bounded source excerpts.",
      argumentSchema: stackTraceArgs,
      resultSchema: errorLocationResult,
      execute: async ({ trace }) => {
        const files = await listWorkspaceFiles(root);
        const locations = extractErrorFiles(trace, files).slice(0, 50);
        return Promise.all(locations.map((location) => inspectLocation(root, {
          path: location.file,
          line: location.line ?? 1,
        })));
      },
    },
    {
      name: "compare_before_after",
      description: "Compare SaMo's snapshot of files changed in this run with their current post-edit contents.",
      argumentSchema: emptyArgs,
      resultSchema: compareResult,
      execute: async () => Promise.all(snapshot.files.slice(0, 40).map(async (file) => {
        const action = touched.get(file.path) ?? (file.applied === undefined ? "delete" : file.existed ? "modify" : "create");
        const current = action === "delete" ? undefined : await readWorkspaceText(root, file.path, 2_000);
        const original = file.original ? Buffer.from(file.original, "base64").toString("utf8") : undefined;
        return {
          path: file.path,
          action,
          ...(original !== undefined ? { before: redactSecrets(original).slice(0, 2_000) } : {}),
          ...(current !== undefined ? { after: redactSecrets(current).slice(0, 2_000) } : {}),
        };
      })),
    },
    {
      name: "detect_project_commands",
      description: "List test, typecheck, lint, and build commands inferred from the workspace manifest without running them.",
      argumentSchema: emptyArgs,
      resultSchema: commandListResult,
      execute: async () => {
        const files = await listWorkspaceFiles(root);
        return (await resolveRegressionPlan(root, files)).slice(0, 4).map((step) => ({
          label: step.label,
          command: step.command,
          args: step.args,
          reason: step.reason,
        }));
      },
    },
    {
      name: "run_typecheck",
      description: "Run only the detected typecheck command after workspace-trust checks and explicit approval.",
      argumentSchema: emptyArgs,
      resultSchema: testsResult,
      execute: (_args, signal) => runDetectedChecks(root, options, signal, ["typecheck"]),
    },
    {
      name: "run_linter",
      description: "Run only the detected lint command after workspace-trust checks and explicit approval.",
      argumentSchema: emptyArgs,
      resultSchema: testsResult,
      execute: (_args, signal) => runDetectedChecks(root, options, signal, ["lint"]),
    },
    {
      name: "run_build",
      description: "Run only the detected build command after workspace-trust checks and explicit approval.",
      argumentSchema: emptyArgs,
      resultSchema: testsResult,
      execute: (_args, signal) => runDetectedChecks(root, options, signal, ["build"]),
    },
    {
      name: "rerun_failed_test",
      description: "Rerun one exact detected automated-test command after workspace-trust checks and explicit approval.",
      argumentSchema: z.object({ label: z.string().min(1).max(200) }).strict(),
      resultSchema: testsResult,
      execute: ({ label }, signal) => runDetectedChecks(root, options, signal, ["automated tests"], label),
    },
    {
      name: "get_changed_files",
      description: "List Git working-tree changes and distinguish SaMo-touched files from pre-existing and newly appeared files.",
      argumentSchema: emptyArgs,
      resultSchema: gitFilesResult,
      execute: async () => {
        const result = await getGitChangedFiles(root);
        return {
          files: result.files.slice(0, 500).map((file) => ({
            ...file,
            owner: touched.has(file.path) ? "samo" : initialGitFiles.has(file.path) ? "pre-existing" : "new-user-change",
          })),
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },
    {
      name: "get_file_diff",
      description: "Read the tracked Git diff for one workspace-relative file, with secrets redacted.",
      argumentSchema: fileArgs,
      resultSchema: gitTextResult,
      execute: async ({ path: file }) => {
        const result = await getFileDiff(root, file);
        return { text: redactSecrets(result.diff), ...(result.error ? { error: result.error } : {}) };
      },
    },
    {
      name: "get_branch_status",
      description: "Inspect the current branch and concise working-tree status without changing Git state.",
      argumentSchema: emptyArgs,
      resultSchema: gitTextResult,
      execute: async () => {
        const result = await getGitBranchStatus(root);
        return { text: redactSecrets(result.status), ...(result.error ? { error: result.error } : {}) };
      },
    },
    {
      name: "inspect_recent_commits",
      description: "Read up to five recent commit summaries without changing Git state.",
      argumentSchema: emptyArgs,
      resultSchema: gitTextResult,
      execute: async () => {
        const result = await getRecentCommits(root);
        return { text: redactSecrets(result.commits.join("\n")), ...(result.error ? { error: result.error } : {}) };
      },
    },
    {
      name: "detect_conflicting_changes",
      description: "Find worktree changes that predate SaMo's current touched-file set or appeared after task start.",
      argumentSchema: emptyArgs,
      resultSchema: gitFilesResult,
      execute: async () => {
        const result = await getGitChangedFiles(root);
        return {
          files: result.files.filter((file) => initialGitFiles.has(file.path) || !touched.has(file.path)).slice(0, 500).map((file) => ({
            ...file,
            owner: touched.has(file.path) ? "samo" : initialGitFiles.has(file.path) ? "pre-existing" : "new-user-change",
          })),
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },
    {
      name: "apply_changes",
      description: "Apply a validated file change set. Existing-file changes require the current SHA-256 from read_file; file deletion requires user approval.",
      argumentSchema: applyArgs,
      resultSchema: applyResult,
      execute: async ({ changeSet }, signal) => {
        if (signal?.aborted) throw new Error("File changes were cancelled before they could be applied.");
        const parsed = parseChangeSet(JSON.stringify(changeSet));
        if (!parsed.ok) throw new Error(`Change set rejected: ${parsed.error}`);
        if (parsed.value.changes.some((change) => change.action === "delete")) {
          const paths = parsed.value.changes.filter((change) => change.action === "delete").map((change) => change.path);
          if (!(await options.confirmDelete(paths))) throw new Error("File deletion was not approved.");
        }
        if (signal?.aborted) throw new Error("File changes were cancelled before they could be applied.");
        const result = await applyChanges(root, parsed.value.changes, snapshot);
        if (!result.ok) throw new Error(`No changes were applied: ${result.errors.join("; ")}`);
        mergeTouched(touched, result.results);
        options.onChangesApplied(result.results, parsed.value.summary, parsed.value.notes);
        return {
          applied: result.results,
          summary: parsed.value.summary,
          notes: parsed.value.notes,
        };
      },
    },
    {
      name: "run_tests",
      description: "Detect project regression commands, ask the user before running them, then return bounded test results.",
      argumentSchema: emptyArgs,
      resultSchema: testsResult,
      execute: (_args, signal) => runDetectedChecks(root, options, signal, ["automated tests"]),
    },
    {
      name: "create_task_plan",
      description: "Keep an internal bounded task plan for genuinely multi-step requests; do not display it as an unsolicited checklist.",
      argumentSchema: createTaskArgs,
      resultSchema: planResult,
      execute: async ({ steps: proposed }: z.infer<typeof createTaskArgs>) => {
        tasks = proposed.map((task) => ({ ...task, status: "pending" }));
        return { tasks };
      },
    },
    {
      name: "update_task_status",
      description: "Update one internal task status after performing or blocking that step.",
      argumentSchema: taskUpdateArgs,
      resultSchema: taskUpdateResult,
      execute: async ({ id, status }: z.infer<typeof taskUpdateArgs>) => {
        const found = tasks.find((task) => task.id === id);
        if (!found) throw new Error(`Internal plan task "${id}" does not exist.`);
        found.status = status;
        return { updated: true, tasks };
      },
    },
    {
      name: "record_evidence",
      description: "Record a bounded evidence note tied to an observed tool result or verification output.",
      argumentSchema: evidenceArgs,
      resultSchema: evidenceResult,
      execute: async ({ claim, source, detail }: z.infer<typeof evidenceArgs>) => {
        evidence.push(`${claim} [${source}]: ${redactSecrets(detail).slice(0, 1_000)}`);
        if (evidence.length > 20) evidence.shift();
        return { recorded: true, count: evidence.length, message: "Evidence note recorded for this run." };
      },
    },
    {
      name: "verify_acceptance_criteria",
      description: "Return recorded evidence for each acceptance criterion; SaMo must not mark a criterion verified without supporting evidence.",
      argumentSchema: acceptanceArgs,
      resultSchema: acceptanceResult,
      execute: async ({ criteria }: z.infer<typeof acceptanceArgs>) => criteria.map((criterion) => ({
        criterion,
        evidence: evidence.filter((entry) => entry.toLocaleLowerCase().includes(criterion.toLocaleLowerCase())).slice(0, 8),
      })),
    },
    {
      name: "summarize_changes",
      description: "Summarize only files actually modified by SaMo in this run and their line-count delta.",
      argumentSchema: emptyArgs,
      resultSchema: taskSummaryResult,
      execute: async () => {
        const stats = snapshotDiffStats(snapshot);
        const files = [...touched].map(([file, action]) => ({ path: file, action }));
        return {
          files,
          ...stats,
          summary: `${files.length} SaMo-touched file(s); ${stats.added} line(s) added and ${stats.removed} removed.`,
        };
      },
    },
    {
      name: "search_mcp_tools",
      description: "Search configured external MCP tools by name or description. Launch and every call still require approval.",
      argumentSchema: mcpSearchArgs,
      resultSchema: mcpSearchResult,
      execute: async ({ query }, signal) => {
        if (!options.mcp) throw new Error("MCP integration is unavailable.");
        const normalized = query.toLocaleLowerCase();
        const tools = await options.mcp.listTools(signal);
        return tools.filter((tool) => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(normalized))
          .slice(0, 100)
          .map((tool) => ({ server: tool.server, name: tool.name, description: redactSecrets(tool.description).slice(0, 1_000) }));
      },
    },
    {
      name: "call_approved_mcp_tool",
      description: "Call a configured MCP tool; the user must approve the server launch and this exact call separately.",
      argumentSchema: mcpCallArgs,
      resultSchema: documentationResult,
      execute: async ({ server, tool, arguments: args }, signal) => {
        if (!options.mcp) throw new Error("MCP integration is unavailable.");
        return formatMcpContent(await options.mcp.callTool(server, tool, args, signal));
      },
    },
    {
      name: "search_documentation",
      description: "Search documentation through a configured MCP documentation-search tool; provide its exact server and tool names from search_mcp_tools.",
      argumentSchema: documentationArgs,
      resultSchema: documentationResult,
      execute: async ({ server, tool, query }, signal) => {
        if (!options.mcp) throw new Error("MCP integration is unavailable.");
        const selected = (await options.mcp.listTools(signal)).find((entry) =>
          entry.server === server && entry.name === tool && /search.*(doc|documentation)|(doc|documentation).*search/i.test(`${entry.name} ${entry.description}`));
        if (!selected) throw new Error("That configured MCP tool is not identified as a documentation search tool.");
        const args = documentedToolArguments(selected.inputSchema, ["query", "q", "search_query", "text"], query);
        return formatMcpContent(await options.mcp.callTool(server, tool, args, signal));
      },
    },
    {
      name: "fetch_documentation_page",
      description: "Fetch a documentation URL through a configured MCP page-fetch tool; server and tool must come from search_mcp_tools.",
      argumentSchema: documentationArgs,
      resultSchema: documentationResult,
      execute: async ({ server, tool, query: url }, signal) => {
        if (!options.mcp) throw new Error("MCP integration is unavailable.");
        const selected = (await options.mcp.listTools(signal)).find((entry) =>
          entry.server === server && entry.name === tool && /(fetch|read|open).*(page|url|document)|(page|url|document).*(fetch|read|open)/i.test(`${entry.name} ${entry.description}`));
        if (!selected) throw new Error("That configured MCP tool is not identified as a documentation page-fetch tool.");
        const args = documentedToolArguments(selected.inputSchema, ["url", "href", "uri", "page_url"], url);
        return formatMcpContent(await options.mcp.callTool(server, tool, args, signal));
      },
    },
  ];
  return tools;
}
