import * as vscode from "vscode";

const defaultRequestInactivityTimeoutSeconds = 120;
const maxTransientRetries = 2;
const transientRetryDelayMs = 1_000;

export interface ChatRequestResult {
  answer?: string;
  error?: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface ChatStreamEvent {
  type?: "status" | "token" | "reset" | "complete" | "error";
  text?: string;
  message?: string;
  answer?: string;
  error?: string;
}

class ChatStreamError extends Error {}

function getNestedString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getNestedString(item);
      if (nested) {
        return nested;
      }
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["answer", "response", "message", "detail", "error"]) {
      const entry = (value as Record<string, unknown>)[key];
      const nested = getNestedString(entry);
      if (nested) {
        return nested;
      }
    }
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const nested = getNestedString(nestedValue);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function getNetworkErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown network error.";
  }

  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    const code = typeof causeRecord.code === "string" ? causeRecord.code : undefined;
    const message = typeof causeRecord.message === "string" ? causeRecord.message : undefined;
    if (code && message) {
      return `${code}: ${message}`;
    }
    if (code) {
      return code;
    }
    if (message) {
      return message;
    }
  }
  return error.message || "Unknown network error.";
}

/**
 * Talks to the deployed SaMo HTTP API (POST /api/chat) using a bearer access
 * token stored in VS Code SecretStorage and the email configured in settings.
 */
export class SamoApiClient {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secretKeyAccessToken: string,
  ) {}

  getApiUrl(): string {
    return vscode.workspace.getConfiguration("samo").get<string>("apiUrl", "").trim();
  }

  normalizeApiUrl(apiUrl: string): string {
    const cleaned = apiUrl.trim().replace(/\/+$/, "");
    if (!cleaned) {
      return "";
    }

    const lower = cleaned.toLowerCase();
    if (lower.endsWith("/api/chat")) {
      return cleaned.replace(/\/api\/chat$/i, "");
    }
    if (lower.endsWith("/chat")) {
      return cleaned.replace(/\/chat$/i, "");
    }
    if (lower.endsWith("/api")) {
      return cleaned.replace(/\/api$/i, "");
    }
    return cleaned;
  }

  getEmail(): string {
    return vscode.workspace.getConfiguration("samo").get<string>("email", "").trim();
  }

  getRequestTimeoutMs(): number {
    const configuredSeconds = vscode.workspace
      .getConfiguration("samo")
      .get<number>("requestTimeoutSeconds", defaultRequestInactivityTimeoutSeconds);
    const seconds = Number.isFinite(configuredSeconds)
      ? Math.min(300, Math.max(15, configuredSeconds))
      : defaultRequestInactivityTimeoutSeconds;
    return seconds * 1_000;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKeyAccessToken);
  }

  async sendMessage(
    message: string,
    history: ChatHistoryItem[] = [],
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatRequestResult> {
    let result = await this.sendOnce(message, history, onEvent);
    for (let attempt = 1; attempt <= maxTransientRetries && result.retryable; attempt += 1) {
      onEvent?.({ type: "status", message: `Connection dropped. Retrying (${attempt}/${maxTransientRetries})...` });
      await new Promise((resolve) => setTimeout(resolve, attempt * transientRetryDelayMs));
      onEvent?.({ type: "reset" });
      result = await this.sendOnce(message, history, onEvent);
    }
    const { retryable: _retryable, ...publicResult } = result;
    return publicResult;
  }

  private async sendOnce(
    message: string,
    history: ChatHistoryItem[],
    onEvent?: (event: ChatStreamEvent) => void,
  ): Promise<ChatRequestResult & { retryable?: boolean }> {
    const apiUrl = this.getApiUrl();
    if (!apiUrl) {
      return { error: 'Set the "samo.apiUrl" setting to your deployed SaMo API URL first.' };
    }

    let requestUrl: string;
    try {
      const endpoint = new URL(`${this.normalizeApiUrl(apiUrl)}/api/chat`);
      if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
        return { error: "The samo.apiUrl setting must use HTTPS (or HTTP for local development)." };
      }
      requestUrl = endpoint.toString();
    } catch {
      return { error: 'The "samo.apiUrl" setting is not a valid URL. Enter the SaMo API base URL, such as https://your-api.example.com.' };
    }

    const email = this.getEmail();
    if (!email) {
      return { error: 'Set the "samo.email" setting to the email address SaMo should record for you.' };
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return { error: 'No access token configured. Run "SaMo: Set Access Token" from the Command Palette.' };
    }

    const requestInactivityTimeoutMs = this.getRequestTimeoutMs();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resetTimeout = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), requestInactivityTimeoutMs);
    };
    const readResponseBody = async (response: Response): Promise<string> => {
      const reader = response.body?.getReader();
      if (!reader) {
        return "";
      }
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { value, done } = await reader.read();
        if (value?.length) {
          resetTimeout();
        }
        text += decoder.decode(value, { stream: !done });
        if (done) {
          return text;
        }
      }
    };
    resetTimeout();

    try {
      onEvent?.({ type: "status", message: "SaMo is preparing your answer..." });
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message, email, history }),
        signal: controller.signal,
      });
      resetTimeout();

      if (!response.ok) {
        const rawText = await readResponseBody(response);
        let body: unknown = rawText;
        try {
          body = JSON.parse(rawText);
        } catch {
          // Keep plain-text API errors readable.
        }
        const errorText = getNestedString(body);
        let guidance = "";
        if (response.status === 401 || response.status === 403) {
          guidance = " Check that the access token is current and authorized.";
        } else if (response.status === 404) {
          guidance = " Check that samo.apiUrl is the API base URL, not a page or frontend URL.";
        } else if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          guidance = retryAfter
            ? ` The service asked you to retry after ${retryAfter} seconds.`
            : " The service is rate-limiting requests; wait briefly before retrying.";
        } else if (response.status >= 500) {
          guidance = " The SaMo service may be temporarily unavailable.";
        }
        const detail = errorText ? ` ${errorText}` : "";
        return { error: `SaMo API returned HTTP ${response.status}.${detail}${guidance}` };
      }

      if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        const rawText = await readResponseBody(response);
        let body: unknown = rawText;
        try {
          body = JSON.parse(rawText);
        } catch {
          // Some API deployments return a plain-text answer.
        }
        const answer = getNestedString(body);
        return answer
          ? { answer }
          : { error: "SaMo returned an empty response. Please check the configured API URL and token." };
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return { error: "SaMo could not stream a response. Please retry." };
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      const handleFrame = (frame: string): void => {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") {
          return;
        }

        let event: ChatStreamEvent;
        try {
          event = JSON.parse(data) as ChatStreamEvent;
        } catch {
          throw new Error("SaMo returned an invalid streaming event.");
        }

        if (event.type === "token" && event.text) {
          answer += event.text;
        } else if (event.type === "reset") {
          answer = "";
        } else if (event.type === "complete" && typeof event.answer === "string") {
          answer = event.answer;
        } else if (event.type === "error") {
          throw new ChatStreamError(
            event.error ?? event.message ?? event.text ?? "The SaMo API did not provide an error description.",
          );
        }
        onEvent?.(event);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (value?.length) {
          resetTimeout();
        }
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          handleFrame(frame);
        }
        if (done) {
          break;
        }
      }
      if (buffer.trim()) {
        handleFrame(buffer);
      }

      if (!answer.trim()) {
        return { error: "SaMo returned an empty response. Please check the configured API URL and token." };
      }
      return { answer };
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutSeconds = Math.round(requestInactivityTimeoutMs / 1_000);
        return {
          error: `SaMo's API sent no response data for ${timeoutSeconds} seconds. The service may be starting or the AI request may be stalled. Check the API service logs and samo.apiUrl, then use Retry to try again.`,
        };
      }
      if (error instanceof ChatStreamError) {
        return {
          error: `The SaMo API reported an error: ${error.message} Check the SaMo service logs for details, then use Retry to try again.`,
        };
      }
      if (!(error instanceof TypeError)) {
        const detail = error instanceof Error ? error.message : "Unknown response error.";
        return { error: `SaMo returned an invalid or incomplete response: ${detail}` };
      }
      const detail = getNetworkErrorDetail(error);
      const host = new URL(requestUrl).host;
      return {
        error: `Could not reach ${host}. Check the samo.apiUrl setting, confirm the API service is online, and verify your network or VPN. Details: ${detail}`,
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
