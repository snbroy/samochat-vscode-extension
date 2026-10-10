const assert = require("node:assert/strict");
const Module = require("node:module");
const { afterEach, test } = require("node:test");

const configuration = {
  apiUrl: "https://samo.example.com",
  email: "dev@example.com",
  requestTimeoutSeconds: 120,
};
const vscodeMock = {
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => configuration[key] ?? fallback,
    }),
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === "vscode"
    ? vscodeMock
    : originalLoad.call(this, request, parent, isMain);
};
const { SamoApiClient } = require("../out/apiClient.js");
Module._load = originalLoad;

const originalFetch = global.fetch;

function createClient(token = "test-token") {
  return new SamoApiClient(
    { secrets: { get: async () => token } },
    "samo.accessToken",
  );
}

afterEach(() => {
  global.fetch = originalFetch;
  configuration.apiUrl = "https://samo.example.com";
  configuration.email = "dev@example.com";
  configuration.requestTimeoutSeconds = 120;
});

test("normalizes supported API URL suffixes", () => {
  const client = createClient();
  assert.equal(client.normalizeApiUrl("https://samo.example.com/api/chat/"), "https://samo.example.com");
  assert.equal(client.normalizeApiUrl("https://samo.example.com/chat"), "https://samo.example.com");
  assert.equal(client.normalizeApiUrl("https://samo.example.com/api"), "https://samo.example.com");
});

test("defaults requests to the SaMo VS Portal when the API URL is empty", async () => {
  configuration.apiUrl = "";
  let requestUrl = "";
  global.fetch = async (input) => {
    requestUrl = String(input);
    return new Response('data: {"type":"complete","answer":"ready"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };

  const result = await createClient().sendMessage("hello");
  assert.equal(requestUrl, "https://vs.samotech.co.in/api/chat");
  assert.equal(result.answer, "ready");
});

test("bounds the configured request inactivity timeout", () => {
  const client = createClient();
  assert.equal(client.getRequestTimeoutMs(), 120_000);
  configuration.requestTimeoutSeconds = 1;
  assert.equal(client.getRequestTimeoutMs(), 15_000);
  configuration.requestTimeoutSeconds = 900;
  assert.equal(client.getRequestTimeoutMs(), 300_000);
});

test("rejects unsupported API protocols without making a request", async () => {
  configuration.apiUrl = "ftp://samo.example.com";
  global.fetch = async () => {
    assert.fail("fetch must not run for an unsupported protocol");
  };

  const result = await createClient().sendMessage("hello");
  assert.match(result.error, /must use HTTPS/);
});

test("returns an actionable HTTP service error", async () => {
  let calls = 0;
  const events = [];
  global.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: "Temporarily unavailable" }),
      {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "1" },
      },
    );
  };
  const result = await createClient().sendMessage("hello", [], (event) => events.push(event.type));
  assert.match(result.error, /HTTP 503/);
  assert.match(result.error, /Temporarily unavailable/);
  assert.match(result.error, /temporarily unavailable/i);
  assert.equal(calls, 2);
  assert.ok(events.includes("reset"));
});

test("keeps Cloudflare HTML gateway errors out of chat and explains how to retry", async () => {
  global.fetch = async () => new Response(
    "<!doctype html><html><title>502: Bad gateway</title><body>Cloudflare error page</body></html>",
    {
      status: 502,
      headers: { "content-type": "text/html", "retry-after": "1" },
    },
  );

  const result = await createClient().sendMessage("hi");
  assert.match(result.error, /HTTP 502/);
  assert.match(result.error, /temporary gateway error/);
  assert.match(result.error, /automatic retry also failed/i);
  assert.doesNotMatch(result.error, /Cloudflare error page|<!doctype|<html/);
});

test("tells the user when a rate-limited request can be retried", async () => {
  global.fetch = async () => new Response(
    JSON.stringify({ message: "Too many requests" }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    },
  );

  const result = await createClient().sendMessage("hello");
  assert.match(result.error, /HTTP 429/);
  assert.match(result.error, /retry after 3 seconds/);
});

test("parses streamed answer events", async () => {
  global.fetch = async () => new Response(
    'data: {"type":"token","text":"Hello"}\n\n' +
      'data: {"type":"complete","answer":"Hello there"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

  const events = [];
  const result = await createClient().sendMessage("hello", [], (event) => events.push(event.type));
  assert.equal(result.answer, "Hello there");
  assert.deepEqual(events, ["status", "token", "complete"]);
});

test("cancels an in-flight request without treating it as an inactivity timeout", async () => {
  global.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new Error("aborted"));
    else init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const controller = new AbortController();
  const pending = createClient().sendMessage("long request", [], undefined, "chat", controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.error, "SaMo request cancelled.");
});

test("sends coding mode to the portal", async () => {
  let payload;
  global.fetch = async (_input, init) => {
    payload = JSON.parse(init.body);
    return new Response('data: {"type":"complete","answer":"done"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const result = await createClient().sendMessage("fix this", [], undefined, "coding");
  assert.equal(result.answer, "done");
  assert.equal(payload.mode, "coding");
});

test("distinguishes malformed stream data from connection failures", async () => {
  global.fetch = async () => new Response(
    "data: {not-json}\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

  const result = await createClient().sendMessage("hello");
  assert.match(result.error, /invalid or incomplete response/);
  assert.doesNotMatch(result.error, /Could not reach/);
});

test("reports errors sent by the SaMo API without mislabeling them as incomplete streams", async () => {
  global.fetch = async () => new Response(
    'data: {"type":"error","message":"AI provider request timed out"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

  const result = await createClient().sendMessage("help build a GWP app step by step");
  assert.match(result.error, /SaMo API reported an error/);
  assert.match(result.error, /AI provider request timed out/);
  assert.match(result.error, /service logs/);
  assert.doesNotMatch(result.error, /invalid or incomplete response/);
});

test("uses a useful fallback when the SaMo API error event has no details", async () => {
  global.fetch = async () => new Response(
    'data: {"type":"error"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

  const result = await createClient().sendMessage("hello");
  assert.match(result.error, /did not provide an error description/);
  assert.match(result.error, /service logs/);
});

test("reports the API host and underlying network error", async () => {
  global.fetch = async () => {
    const cause = Object.assign(new Error("Name or service not known"), { code: "ENOTFOUND" });
    throw new TypeError("fetch failed", { cause });
  };

  const result = await createClient().sendMessage("hello");
  assert.match(result.error, /samo\.example\.com/);
  assert.match(result.error, /ENOTFOUND/);
});

test("retries a dropped connection and succeeds without surfacing the error", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      const error = new TypeError("fetch failed");
      error.cause = { code: "UND_ERR_SOCKET", message: "other side closed" };
      throw error;
    }
    return new Response(JSON.stringify({ answer: "recovered" }), { headers: { "content-type": "application/json" } });
  };
  const result = await createClient().sendMessage("hello");
  assert.equal(calls, 3);
  assert.deepEqual(result, { answer: "recovered" });
});

test("reports the network error after retries are exhausted", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const error = new TypeError("fetch failed");
    error.cause = { code: "UND_ERR_SOCKET", message: "other side closed" };
    throw error;
  };
  const result = await createClient().sendMessage("hello");
  assert.equal(calls, 3);
  assert.match(result.error, /Could not reach samo\.example\.com.*UND_ERR_SOCKET/);
  assert.equal("retryable" in result, false);
});
