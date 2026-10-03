const assert = require("node:assert/strict");
const { test } = require("node:test");

const { renderMarkdown } = require("../media/markdown.js");

test("renders rich text, lists, tables, links, and fenced code", () => {
  const html = renderMarkdown([
    "# Gift with purchase",
    "",
    "**Free gift** with *eligible* products.",
    "",
    "- Select a gift",
    "- Add it to the cart",
    "",
    "| Mode | Gift |",
    "| --- | --- |",
    "| Buyer-selected | Free product |",
    "",
    "[Shopify](https://shopify.dev)",
    "",
    "```typescript",
    "const gift = '<gift>';",
    "```",
  ].join("\n"));

  assert.match(html, /<h1>Gift with purchase<\/h1>/);
  assert.match(html, /<strong>Free gift<\/strong>/);
  assert.match(html, /<em>eligible<\/em>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /class="language-typescript"/);
  assert.match(html, /<button class="copy-code-btn"/);
  assert.match(html, /const gift = '&lt;gift&gt;';/);
});

test("escapes raw HTML and rejects unsafe link protocols", () => {
  const html = renderMarkdown(
    '<img src=x onerror="alert(1)">\n\n[run](javascript:alert(1))',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img\b[^>]*>/);
  assert.doesNotMatch(html, /href="javascript:/i);
});
