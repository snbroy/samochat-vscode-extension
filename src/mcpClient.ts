import * as vscode from "vscode";
import { z } from "zod";
import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const maxServers = 12;
const maxConfigEntries = 256;
const maxServerArguments = 64;
const maxEnvironmentVariables = 64;
const maxArguments = 32_000;
const maxToolResultBytes = 64_000;
const maxToolResultItems = 50;
const requestTimeoutMs = 15_000;
const ajv = new Ajv({ allErrors: true, strict: false });

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  toolResult?: unknown;
}

interface McpConnection {
  listTools(_params?: Record<string, never>, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, _schema?: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface ActiveServer {
  signature: string;
  client: McpConnection;
}

const serverConfigSchema = z.object({
  name: z.string().trim().regex(/^[\w.-]{1,64}$/),
  command: z.string().trim().min(1).max(512),
  args: z.array(z.string().max(2048)).max(maxServerArguments).default([]),
  env: z.record(z.string(), z.string().max(8192)).default({}),
}).strict();

export function parseMcpServerConfigs(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];

  const configs: McpServerConfig[] = [];
  const names = new Set<string>();
  for (const candidate of raw.slice(0, maxConfigEntries)) {
    if (configs.length >= maxServers) break;
    const parsed = serverConfigSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { name, command, args, env } = parsed.data;
    if (names.has(name)) continue;
    names.add(name);
    configs.push({
      name,
      command,
      args,
      env: Object.fromEntries(Object.entries(env).slice(0, maxEnvironmentVariables)),
    });
  }
  return configs;
}

function getUserServerConfigs(): McpServerConfig[] {
  const raw = vscode.workspace.getConfiguration("samo").inspect<unknown>("mcp.servers")?.globalValue;
  return parseMcpServerConfigs(raw);
}

async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "samo-chat", version: "0.4.13" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    ...(Object.keys(config.env).length ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
    stderr: "ignore",
  });
  try {
    await client.connect(transport, { timeout: requestTimeoutMs });
    return client;
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

export class McpClientManager implements vscode.Disposable {
  private readonly active = new Map<string, ActiveServer>();
  private readonly connecting = new Map<string, Promise<McpConnection>>();
  private disposed = false;

  constructor(
    private readonly configs: () => McpServerConfig[] = getUserServerConfigs,
    private readonly connect: (config: McpServerConfig) => Promise<McpConnection> = connectMcpServer,
    private readonly confirmLaunch: (config: McpServerConfig) => Promise<boolean> = async (config) =>
      (await vscode.window.showWarningMessage(
        `Start MCP server "${config.name}"?`,
        { modal: true, detail: `SaMo will run: ${config.command} ${config.args.join(" ")}` },
        "Start server",
      )) === "Start server",
    private readonly confirmTool: (config: McpServerConfig, tool: McpToolInfo, args: Record<string, unknown>) => Promise<boolean> = async (config, tool, args) =>
      (await vscode.window.showWarningMessage(
        `Allow MCP tool "${tool.name}" from "${config.name}" to run once?`,
        {
          modal: true,
          detail: [
            `Server-supplied purpose (untrusted): ${tool.description || "Not provided."}`,
            `Arguments: ${JSON.stringify(args, null, 2).slice(0, 6_000)}`,
          ].join("\n\n"),
        },
        "Run once",
      )) === "Run once",
  ) {}

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    this.assertWorkspaceTrusted();
    if (signal?.aborted) throw new Error("MCP tool discovery was cancelled.");
    const tools: McpToolInfo[] = [];
    for (const config of this.configs()) {
      const connection = await this.getConnection(config);
      const response = await connection.listTools({}, { timeout: requestTimeoutMs, signal });
      tools.push(...response.tools.map((tool) => ({
        server: config.name,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })));
    }
    return tools;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    this.assertWorkspaceTrusted();
    if (signal?.aborted) throw new Error("MCP tool execution was cancelled.");
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > maxArguments) {
      throw new Error(`MCP tool arguments exceed ${maxArguments} bytes.`);
    }
    const config = this.configs().find((candidate) => candidate.name === serverName);
    if (!config) throw new Error(`MCP server "${serverName}" is not configured in user settings.`);

    const connection = await this.getConnection(config);
    const tools = await connection.listTools({}, { timeout: requestTimeoutMs, signal });
    const selected = tools.tools.find((tool) => tool.name === toolName);
    if (!selected) throw new Error(`MCP tool "${toolName}" is not offered by server "${serverName}".`);
    let inputValidator: ReturnType<typeof ajv.compile>;
    try {
      inputValidator = ajv.compile(selected.inputSchema);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unsupported JSON Schema";
      throw new Error(`The MCP server returned an invalid input schema for "${toolName}": ${detail}`);
    }
    if (!inputValidator(args)) {
      const detail = ajv.errorsText(inputValidator.errors, { separator: "; " });
      throw new Error(`Arguments for MCP tool "${toolName}" do not match its input schema: ${detail}`);
    }
    const info: McpToolInfo = {
      server: serverName,
      name: selected.name,
      description: selected.description ?? "",
      inputSchema: selected.inputSchema,
    };
    if (!(await this.confirmTool(config, info, args))) {
      throw new Error(`MCP tool "${toolName}" was not approved.`);
    }
    if (signal?.aborted) throw new Error("MCP tool execution was cancelled.");
    const result = await connection.callTool({ name: toolName, arguments: args }, undefined, { timeout: requestTimeoutMs, signal });
    if (result.toolResult !== undefined) {
      throw new Error(`MCP tool "${toolName}" requires task-based execution, which is not yet supported.`);
    }
    if (!Array.isArray(result.content) || result.content.length > maxToolResultItems) {
      throw new Error(`MCP tool "${toolName}" returned an invalid or oversized result.`);
    }
    if (Buffer.byteLength(JSON.stringify(result.content), "utf8") > maxToolResultBytes) {
      throw new Error(`MCP tool "${toolName}" returned more than ${maxToolResultBytes} bytes.`);
    }
    return { content: result.content, isError: result.isError };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.connecting.values()]);
    const active = [...this.active.values()];
    this.active.clear();
    await Promise.all(active.map(({ client }) => client.close()));
  }

  private async getConnection(config: McpServerConfig): Promise<McpConnection> {
    if (this.disposed) throw new Error("The MCP client manager has been disposed.");
    const signature = JSON.stringify(config);
    const current = this.active.get(config.name);
    if (current?.signature === signature) return current.client;
    if (current) {
      this.active.delete(config.name);
      await current.client.close();
    }
    if (this.disposed) throw new Error("The MCP client manager has been disposed.");

    const pending = this.connecting.get(config.name);
    if (pending) {
      const client = await pending;
      const active = this.active.get(config.name);
      if (!this.disposed && active?.signature === signature && active.client === client) return client;
      throw new Error(`MCP server "${config.name}" changed configuration or shut down while starting; retry the request.`);
    }

    const connecting = (async (): Promise<McpConnection> => {
      if (!(await this.confirmLaunch(config))) {
        throw new Error(`MCP server "${config.name}" was not started.`);
      }
      return this.connect(config);
    })();
    this.connecting.set(config.name, connecting);
    try {
      const client = await connecting;
      if (this.disposed) {
        await client.close();
        throw new Error("The MCP client manager has been disposed.");
      }
      this.active.set(config.name, { signature, client });
      return client;
    } finally {
      if (this.connecting.get(config.name) === connecting) this.connecting.delete(config.name);
    }
  }

  private assertWorkspaceTrusted(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error("MCP servers are disabled until this workspace is trusted.");
    }
  }
}
