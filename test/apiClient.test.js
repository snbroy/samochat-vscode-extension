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
  global.fetch = async () => new Response(
    JSON.stringify({ error: "Temporarily unavailable" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

  const result = await createClient().sendMessage("hello");
  assert.match(result.error, /HTTP 503/);
  assert.match(result.error, /Temporarily unavailable/);
  assert.match(result.error, /temporarily unavailable/);
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
