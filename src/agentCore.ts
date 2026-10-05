import * as path from "node:path";

export type Intent = "chat" | "understand" | "develop" | "debug" | "review" | "pr";
export type ChangeAction = "create" | "modify" | "delete";

export interface TextEdit {
  find: string;
  replace: string;
}

export interface FileChange {
  path: string;
  action: ChangeAction;
  content?: string;
  edits?: TextEdit[];
}

export interface ChangeSetPayload {
  summary: string;
  plan: string[];
  notes: string;
  changes: FileChange[];
}

export type ParseResult = { ok: true; value: ChangeSetPayload } | { ok: false; error: string };

export const maxChangedFiles = 40;
export const maxFileChars = 500_000;

const ignoredSegments = new Set([
  ".git", "node_modules", "dist", "out", "build", ".next", ".nuxt", ".cache", "coverage",
  "vendor", ".venv", "venv", "__pycache__", ".idea", ".vscode-test", "target", ".turbo", ".shopify",
]);
const binaryExtensions = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "gz", "tgz", "vsix", "woff", "woff2",
  "ttf", "eot", "mp4", "mov", "mp3", "wasm", "exe", "dll", "so", "dylib", "bin", "lock", "map",
]);
const ignoredFiles = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".DS_Store"]);

export function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((part) => ignoredSegments.has(part)) || ignoredSegments.has(name)) {
    return true;
  }
  if (ignoredFiles.has(name) || name.endsWith(".min.js") || name.endsWith(".bundle.js")) {
    return true;
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return binaryExtensions.has(ext);
}

/** Paths SaMo must never write, even inside the workspace. */
export function isProtectedWritePath(relPath: string): boolean {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1].toLowerCase();
  return parts.includes(".git") || parts.includes("node_modules") || name === ".env" || name.startsWith(".env.");
}

export function validateRelativePath(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "Path is empty." };
  }
  const raw = input.trim().replace(/\\/g, "/");
  if (raw.includes("\0")) {
    return { ok: false, error: `Path "${input}" contains invalid characters.` };
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    return { ok: false, error: `Path "${input}" must be relative to the workspace.` };
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.endsWith("/")) {
    return { ok: false, error: `Path "${input}" is outside the workspace or not a file.` };
  }
  if (isProtectedWritePath(normalized)) {
    return { ok: false, error: `Path "${input}" is protected and cannot be modified.` };
  }
  return { ok: true, path: normalized };
}

/** Resolves a validated relative path and guarantees it stays under root. */
export function resolveInside(root: string, relPath: string): string | undefined {
  const absolute = path.resolve(root, relPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return absolute;
}

export function formatFileTree(paths: string[], maxChars = 6000): string {
  const sorted = [...paths].sort();
  const lines: string[] = [];
  const seenDirs = new Set<string>();
  let length = 0;
  let shown = 0;
  for (const file of sorted) {
    const parts = file.split("/");
    const entries: string[] = [];
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const dir = parts.slice(0, depth + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        entries.push(`${"  ".repeat(depth)}${parts[depth]}/`);
      }
    }
    entries.push(`${"  ".repeat(parts.length - 1)}${parts[parts.length - 1]}`);
    const addition = entries.join("\n").length + 1;
    if (length + addition > maxChars) {
      break;
    }
    lines.push(...entries);
    length += addition;
    shown += 1;
  }
  if (shown < sorted.length) {
    lines.push(`... (${sorted.length - shown} more files not shown)`);
  }
  return lines.join("\n");
}

const interrogativeStart = /^\s*(what|why|how (does|do|is|are|can)|when|where|who|which|is |are |does |do |can you (explain|tell)|could you (explain|tell)|explain|tell me|describe|difference)/i;
const changeVerbs = /\b(add|create|implement|build|write|fix|update|modify|change|refactor|delete|remove|rename|generate|develop|integrate|migrate|rewrite|improve|patch|debug|resolve|complete|finish|extend|support|make)\b/i;
const codeNouns = /\b(code|file|files|function|class|component|feature|test|tests|endpoint|api|route|page|module|bug|error|button|form|service|hook|query|mutation|schema|logic|ui|style|css|config|script|wishlist|handler|validation)\b/i;

export function detectIntent(prompt: string): Intent {
  const text = prompt.trim();
  if (/\b(create|open|raise|make|submit|send)\b.*\b(pr|pull request|pull-request)\b/i.test(text)
    || /\bpush\b.*\b(branch|changes)\b.*\b(pr|pull request)\b/i.test(text)) {
    return "pr";
  }
  if (/\b(review|revise|revision|revisions|critique|audit)\b.*\b(pr|pull request|diff|changes|my code|branch|commit)\b/i.test(text)) {
    return "review";
  }
  if (/\b(understand|analy[sz]e|learn|scan|read|index|walk ?through|map|overview of|summari[sz]e)\b.*\b(project|app|application|workspace|codebase|code base|repo|repository|folder|directory|dir|file|module|architecture)\b/i.test(text)
    && !/\b(then|and then|and)\s+(add|implement|build|fix|create|develop|complete)\b/i.test(text)) {
    return "understand";
  }
  if (/\bunderstand (this|the|my|our)\b/i.test(text)) {
    return "understand";
  }
  if (isErrorReport(text)) {
    return "debug";
  }
  if (interrogativeStart.test(text) && !/^\s*(please\s+)?(add|create|implement|fix|build)\b/i.test(text)) {
    return "chat";
  }
  if (changeVerbs.test(text) && codeNouns.test(text)) {
    return "develop";
  }
  return "chat";
}

/** Whether a chat prompt refers to the open editor ("this file", "selection", ...). */
export function mentionsEditor(prompt: string): boolean {
  return /\b(this|current|open|selected|above|below)\s+(file|code|function|class|selection|line|lines|component|snippet|method|tab)\b|\bselection\b|\bin (the )?editor\b/i.test(prompt);
}

export function findMentionedPaths(prompt: string, files: string[]): { files: string[]; folders: string[] } {
  const tokens = prompt.match(/[\w@.\-/\\]+/g) ?? [];
  const found = new Set<string>();
  const folders = new Set<string>();
  const folderList = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      folderList.add(parts.slice(0, i).join("/"));
    }
  }
  for (const rawToken of tokens) {
    const token = rawToken.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/[.,;:]+$/, "").replace(/\/+$/, "");
    if (token.length < 3) {
      continue;
    }
    if (folderList.has(token)) {
      folders.add(token);
      continue;
    }
    for (const file of files) {
      if (file === token || file.endsWith(`/${token}`)) {
        found.add(file);
      }
    }
    if (token.includes("/")) {
      for (const folder of folderList) {
        if (folder.endsWith(`/${token}`)) {
          folders.add(folder);
        }
      }
    }
  }
  return { files: [...found], folders: [...folders] };
}

/** Rank workspace files by overlap between prompt keywords and path segments. */
export function rankFilesByKeywords(prompt: string, files: string[], limit: number): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "add", "make", "create", "update", "feature", "code", "file", "files", "please", "need", "want", "should", "using", "use"]);
  const words = (prompt.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((word) => !stop.has(word));
  if (!words.length) {
    return [];
  }
  const scored = files
    .map((file) => {
      const lower = file.toLowerCase();
      let score = 0;
      for (const word of new Set(words)) {
        if (lower.includes(word)) {
          score += lower.split("/").pop()!.includes(word) ? 3 : 1;
        }
      }
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((entry) => entry.file);
}

export function extractJson(text: string): unknown {
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    candidates.push(match[1].trim());
  }
  candidates.push(text.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

export function parseChangeSet(text: string): ParseResult {
  const data = extractJson(text) as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "No JSON object found in the reply." };
  }
  if (!Array.isArray(data.changes)) {
    return { ok: false, error: 'JSON is missing the "changes" array.' };
  }
  if (data.changes.length > maxChangedFiles) {
    return { ok: false, error: `Too many file changes (${data.changes.length}); the limit is ${maxChangedFiles}.` };
  }
  const changes: FileChange[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (data.changes as unknown[]).entries()) {
    const item = entry as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      return { ok: false, error: `changes[${index}] is not an object.` };
    }
    const action = item.action;
    if (action !== "create" && action !== "modify" && action !== "delete") {
      return { ok: false, error: `changes[${index}].action must be create, modify, or delete.` };
    }
    const checked = validateRelativePath(item.path);
    if (!checked.ok) {
      return { ok: false, error: `changes[${index}]: ${checked.error}` };
    }
    if (seen.has(checked.path)) {
      return { ok: false, error: `Duplicate change for ${checked.path}.` };
    }
    seen.add(checked.path);
    const change: FileChange = { path: checked.path, action };
    if (action !== "delete") {
      if (typeof item.content === "string") {
        if (item.content.length > maxFileChars) {
          return { ok: false, error: `${checked.path} exceeds the ${maxFileChars} character limit.` };
        }
        change.content = item.content;
      } else if (action === "modify" && Array.isArray(item.edits) && item.edits.length) {
        const edits: TextEdit[] = [];
        for (const edit of item.edits as Array<Record<string, unknown>>) {
          if (!edit || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") {
            return { ok: false, error: `${checked.path} has an invalid edit; each needs "find" and "replace" strings.` };
          }
          edits.push({ find: edit.find, replace: edit.replace });
        }
        change.edits = edits;
      } else {
        return { ok: false, error: `${checked.path} needs a "content" string${action === "modify" ? ' or "edits" array' : ""}.` };
      }
    }
    changes.push(change);
  }
  return {
    ok: true,
    value: {
      summary: typeof data.summary === "string" ? data.summary : "",
      plan: Array.isArray(data.plan) ? data.plan.filter((step): step is string => typeof step === "string") : [],
      notes: typeof data.notes === "string" ? data.notes : "",
      changes,
    },
  };
}

export function applyTextEdits(original: string, edits: TextEdit[]): string {
  let result = original;
  for (const edit of edits) {
    const first = result.indexOf(edit.find);
    if (first < 0) {
      throw new Error(`Edit target not found: "${edit.find.slice(0, 60)}"`);
    }
    if (result.indexOf(edit.find, first + 1) >= 0) {
      throw new Error(`Edit target is ambiguous (multiple matches): "${edit.find.slice(0, 60)}"`);
    }
    result = result.slice(0, first) + edit.replace + result.slice(first + edit.find.length);
  }
  return result;
}

export function matchEol(original: string, next: string): string {
  if (original.includes("\r\n") && !next.includes("\r\n")) {
    return next.replace(/\n/g, "\r\n");
  }
  return next;
}

export function addLineNumbers(content: string): string {
  const lines = content.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, " ")}| ${line}`).join("\n");
}

export interface TextBatchItem {
  path: string;
  content: string;
}

export function batchByBudget(items: TextBatchItem[], budget: number): TextBatchItem[][] {
  const batches: TextBatchItem[][] = [];
  let current: TextBatchItem[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = item.content.length + item.path.length + 20;
    if (current.length && size + itemSize > budget) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

const priorityNames = /(^|\/)(package\.json|README(\.md)?|shopify\.app(\.[\w-]+)?\.toml|shopify\.extension\.toml|tsconfig\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|composer\.json|Gemfile|Dockerfile|vite\.config\.\w+|remix\.config\.\w+|next\.config\.\w+|schema\.prisma)$/i;
const entryNames = /(^|\/)(index|main|app|server|extension|root|entry\.server|entry\.client)\.\w+$/i;

export function sortByUnderstandingPriority(files: string[]): string[] {
  const rank = (file: string): number => {
    if (priorityNames.test(file)) {
      return 0;
    }
    if (entryNames.test(file)) {
      return 1;
    }
    if (/(^|\/)(src|app|lib|extensions)\//.test(file)) {
      return 2;
    }
    return /(test|spec)\./.test(file) ? 4 : 3;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface TestCommand {
  command: string;
  args: string[];
  label: string;
}

export function detectTestCommand(files: Set<string>, packageJsonText?: string): TestCommand | undefined {
  if (packageJsonText) {
    try {
      const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.test;
      if (script && !/no test specified/i.test(script)) {
        const manager = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : "npm";
        return { command: manager, args: manager === "npm" ? ["test", "--silent"] : ["test"], label: `${manager} test` };
      }
    } catch {
      // fall through to other ecosystems
    }
  }
  if (files.has("go.mod")) {
    return { command: "go", args: ["test", "./..."], label: "go test ./..." };
  }
  if (files.has("Cargo.toml")) {
    return { command: "cargo", args: ["test"], label: "cargo test" };
  }
  if (files.has("pytest.ini") || files.has("pyproject.toml") || files.has("tox.ini")) {
    return { command: "python3", args: ["-m", "pytest", "-q"], label: "pytest -q" };
  }
  return undefined;
}

export function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? `...${text.slice(-maxChars)}` : text;
}

export function slugify(text: string, maxLength = 40): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength).replace(/-+$/g, "");
  return slug || "change";
}

export const developJsonContract = `Reply with ONLY one JSON object (no Markdown fences, no prose) using exactly this shape:
{
  "summary": "one or two sentences describing what you changed and why",
  "plan": ["short step", "..."],
  "notes": "optional caveats or follow-ups",
  "changes": [
    { "path": "relative/path.ext", "action": "create", "content": "complete file content" },
    { "path": "relative/path.ext", "action": "modify", "content": "complete new file content" },
    { "path": "relative/path.ext", "action": "modify", "edits": [{ "find": "exact unique existing text", "replace": "new text" }] },
    { "path": "relative/path.ext", "action": "delete" }
  ]
}
Rules: paths are relative to the workspace root and must stay inside it; never touch .git, node_modules or .env files; prefer "edits" for small changes to large files and "content" for new files or full rewrites; every "find" must match exactly once; follow the project's existing conventions; for any new or changed behavior also add or update automated regression tests that fit the project's existing test framework; return {"summary":"...","plan":[],"notes":"","changes":[]} if no file change is needed.`;

const errorSignals = /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|Uncaught|UnhandledPromiseRejection|Traceback \(most recent call last\)|npm ERR!|error TS\d+|ENOENT|EADDRINUSE|ECONNREFUSED|Cannot find module|Module not found|Failed to compile|is not defined|is not a function|Cannot read propert(y|ies)|undefined is not|panic:|Exception|NullPointerException|GraphQL error|Internal Server Error|stack trace)\b|\bat .+\(.+:\d+:\d+\)|File ".+", line \d+|\bERROR\b|\b[45]\d\d \(/i;
const fixWords = /\b(fix|resolve|solve|debug|repair|getting|gets|got|shows?|throws?|failing|fails|broken|crash(es|ed)?)\b/i;

/** True when the text looks like a pasted console error / stack trace that should be fixed. */
export function isErrorReport(text: string): boolean {
  if (!errorSignals.test(text)) {
    return false;
  }
  const hasStack = /\bat .+:\d+(:\d+)?\)?|File ".+", line \d+|\.\w{1,5}:\d+/.test(text);
  const multiline = text.trim().split(/\r?\n/).length >= 3;
  if (/^\s*(what|explain|describe)\b/i.test(text) && !hasStack && !fixWords.test(text)) {
    return false;
  }
  return hasStack || multiline || fixWords.test(text);
}

export interface ErrorLocation {
  file: string;
  line?: number;
}

/** Maps file paths mentioned in stack traces / logs onto workspace files. */
export function extractErrorFiles(text: string, files: string[]): ErrorLocation[] {
  const known = new Set(files);
  const found = new Map<string, ErrorLocation>();
  const tokens = text.matchAll(/([\w@.\-~/\\:]+?\.[A-Za-z0-9]{1,6})(?::(\d+))?(?::\d+)?(?=[\s)'",\]]|$)/g);
  for (const match of tokens) {
    const segments = match[1].replace(/\\/g, "/").replace(/^file:\/*/, "").split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join("/");
      const hit = known.has(suffix) ? suffix : files.find((file) => file.endsWith(`/${suffix}`));
      if (hit) {
        if (!found.has(hit)) {
          found.set(hit, { file: hit, line: match[2] ? Number(match[2]) : undefined });
        }
        break;
      }
    }
  }
  return [...found.values()];
}

export interface PlanTask {
  title: string;
  details: string;
  files: string[];
}

export interface WorkPlan {
  goal: string;
  analysis: string;
  tasks: PlanTask[];
}

export const maxPlanTasks = 8;

export function parsePlan(text: string): WorkPlan | undefined {
  const data = extractJson(text) as Record<string, unknown> | undefined;
  if (!data || !Array.isArray(data.tasks)) {
    return undefined;
  }
  const tasks: PlanTask[] = [];
  for (const entry of data.tasks as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object" || typeof entry.title !== "string" || !entry.title.trim()) {
      continue;
    }
    const files = Array.isArray(entry.files)
      ? entry.files.map((file) => validateRelativePath(file)).flatMap((checked) => (checked.ok ? [checked.path] : []))
      : [];
    tasks.push({
      title: entry.title.trim().slice(0, 140),
      details: typeof entry.details === "string" ? entry.details.slice(0, 1500) : "",
      files,
    });
    if (tasks.length >= maxPlanTasks) {
      break;
    }
  }
  if (!tasks.length) {
    return undefined;
  }
  return {
    goal: typeof data.goal === "string" ? data.goal : "",
    analysis: typeof data.analysis === "string" ? data.analysis : "",
    tasks,
  };
}

export type TaskState = "pending" | "running" | "done" | "failed";

export function renderTaskBoard(plan: { goal: string; analysis: string }, tasks: Array<{ title: string; state: TaskState; note?: string }>): string {
  const icon: Record<TaskState, string> = { pending: "⬜", running: "⏳", done: "✅", failed: "❌" };
  const done = tasks.filter((task) => task.state === "done").length;
  const lines: string[] = [];
  if (plan.goal) {
    lines.push(`**Goal:** ${plan.goal}`, "");
  }
  if (plan.analysis) {
    lines.push(`**Analysis:** ${plan.analysis}`, "");
  }
  lines.push(`**Task list** (${done}/${tasks.length} complete)`, "");
  tasks.forEach((task, index) => {
    lines.push(`${index + 1}. ${icon[task.state]} ${task.title}${task.note ? ` — _${task.note}_` : ""}`);
  });
  return lines.join("\n");
}

export const planJsonContract = `Reply with ONLY one JSON object (no fences, no prose):
{
  "goal": "one sentence restating what must be achieved",
  "analysis": "for errors: the root cause and where it originates; otherwise key design decisions",
  "tasks": [
    { "title": "short imperative task", "details": "what exactly to change and why", "files": ["relative/path/to/touch.ext"] }
  ]
}
Rules: 2-${maxPlanTasks} small ordered tasks; use real paths from the workspace tree (new files allowed); the final task must add or update automated regression tests for the change; for an error report, the first task fixes the root cause in the file where it originates, not just the symptom.`;
