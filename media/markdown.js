"use strict";

const MarkdownIt = require("markdown-it");

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0];
  const escapedLanguage = markdown.utils.escapeHtml(language);
  const label = escapedLanguage || "Code";
  const codeClass = escapedLanguage ? ` class="language-${escapedLanguage}"` : "";
  const code = markdown.utils.escapeHtml(token.content);

  return `<div class="code-block"><div class="code-header"><span class="code-language">${label}</span><button class="copy-code-btn" type="button" aria-label="Copy code">Copy</button></div><pre><code${codeClass}>${code}</code></pre></div>\n`;
};

markdown.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

markdown.renderer.rules.link_open = (tokens, index, _options, _env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, _options);
};

function renderMarkdown(text) {
  return markdown.render(String(text ?? ""));
}

module.exports = { renderMarkdown };
