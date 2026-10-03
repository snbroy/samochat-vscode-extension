(function () {
  const { renderMarkdown } = require("./markdown");
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const emptyStateEl = document.getElementById("empty-state");
  const inputEl = document.getElementById("input");
  const editorContextEl = document.getElementById("editor-context");
  const sendBtn = document.getElementById("send-btn");
  const clearBtn = document.getElementById("clear-btn");

  let thinking = false;
  let thinkingStatus = "SaMo is thinking";

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function avatarFor(role) {
    if (role === "user") return "You";
    if (role === "assistant") return "S";
    return "!";
  }

  function render(messagesList) {
    messagesEl.innerHTML = "";
    emptyStateEl.style.display = messagesList.length === 0 ? "block" : "none";

    messagesList.forEach((message, messageIndex) => {
      const row = document.createElement("div");
      row.className = `message ${message.role}`;

      const avatar = document.createElement("div");
      avatar.className = "bubble-avatar";
      avatar.textContent = avatarFor(message.role);

      const bubble = document.createElement("div");
      bubble.className = "bubble markdown-body";
      bubble.innerHTML = message.role === "assistant" && !message.text.trim()
        ? (thinking ? "" : "No response was received. Try sending your message again.")
        : renderMarkdown(message.text);

      row.appendChild(avatar);
      row.appendChild(bubble);

      if (message.role === "system" && message.retry) {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "fix-btn apply";
        retryBtn.textContent = "Retry";
        retryBtn.disabled = thinking;
        retryBtn.addEventListener("click", () => {
          vscode.postMessage({ type: "retry", index: messageIndex });
        });
        row.appendChild(retryBtn);
      }

      if (message.role === "assistant" && message.fix && message.fix.code) {
        const { fix } = message;
        if (fix.status === "applied" || fix.status === "pending") {
          const fixActions = document.createElement("div");
          fixActions.className = "fix-actions";

          if (fix.status === "applied") {
            const undoBtn = document.createElement("button");
            undoBtn.type = "button";
            undoBtn.className = "fix-btn keep";
            undoBtn.textContent = "Undo";
            undoBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "undoFix", fixId: fix.id });
            });

            const keepBtn = document.createElement("button");
            keepBtn.type = "button";
            keepBtn.className = "fix-btn apply";
            keepBtn.textContent = "Keep changes";
            keepBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "keepFix", fixId: fix.id });
            });
            fixActions.appendChild(undoBtn);
            fixActions.appendChild(keepBtn);
          } else {
            const applyBtn = document.createElement("button");
            applyBtn.type = "button";
            applyBtn.className = "fix-btn apply";
            applyBtn.textContent = "Apply fix";
            applyBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "applyFix", fixId: fix.id });
            });

            const dismissBtn = document.createElement("button");
            dismissBtn.type = "button";
            dismissBtn.className = "fix-btn keep";
            dismissBtn.textContent = "Dismiss";
            dismissBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "keepFix", fixId: fix.id });
            });
            fixActions.appendChild(applyBtn);
            fixActions.appendChild(dismissBtn);
          }
          row.appendChild(fixActions);
        } else if (fix.status === "kept" || fix.status === "undone" || fix.status === "dismissed" || fix.status === "notApplied") {
          const fixState = document.createElement("div");
          fixState.className = "fix-state";
          fixState.textContent = fix.status === "kept"
            ? "Changes kept."
            : fix.status === "undone"
              ? "Changes undone."
              : fix.status === "dismissed"
                ? "Suggestion dismissed."
                : "Not applied. Review the suggested code before applying it manually.";
          row.appendChild(fixState);
        }
      }

      messagesEl.appendChild(row);
    });

    if (thinking) {
      const row = document.createElement("div");
      row.className = "message assistant";
      const avatar = document.createElement("div");
      avatar.className = "bubble-avatar";
      avatar.textContent = "S";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.innerHTML = `<div class="typing"><span></span><span></span><span></span><small>${escapeHtml(thinkingStatus)}</small></div>`;
      row.appendChild(avatar);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
  }

  function updateSendState() {
    sendBtn.disabled = thinking || inputEl.value.trim().length === 0;
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || thinking) return;
    vscode.postMessage({
      type: "sendMessage",
      text,
      includeEditorContext: editorContextEl.checked,
    });
    inputEl.value = "";
    autoResize();
    updateSendState();
  }

  inputEl.addEventListener("input", () => {
    autoResize();
    updateSendState();
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  sendBtn.addEventListener("click", send);
  clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clear" }));

  messagesEl.addEventListener("click", async (event) => {
    const target = event.target;
    const copyButton = target instanceof Element ? target.closest(".copy-code-btn") : null;
    if (!(copyButton instanceof HTMLButtonElement)) return;

    const code = copyButton.closest(".code-block")?.querySelector("pre code")?.textContent ?? "";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const clipboardInput = document.createElement("textarea");
        clipboardInput.value = code;
        clipboardInput.setAttribute("readonly", "");
        clipboardInput.style.position = "fixed";
        clipboardInput.style.opacity = "0";
        document.body.appendChild(clipboardInput);
        clipboardInput.select();
        const copied = document.execCommand("copy");
        clipboardInput.remove();
        if (!copied) throw new Error("Clipboard access was denied.");
      }

      copyButton.textContent = "Copied";
      window.setTimeout(() => {
        if (copyButton.isConnected) copyButton.textContent = "Copy";
      }, 1500);
    } catch {
      copyButton.textContent = "Copy failed";
      window.setTimeout(() => {
        if (copyButton.isConnected) copyButton.textContent = "Copy";
      }, 2000);
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "history") {
      render(message.messages);
    } else if (message.type === "thinking") {
      thinking = Boolean(message.value);
      if (!thinking) thinkingStatus = "SaMo is thinking";
      updateSendState();
      render(getLastRenderedMessages());
    } else if (message.type === "status") {
      thinkingStatus = String(message.text ?? "SaMo is working");
      render(getLastRenderedMessages());
    }
  });

  let lastMessages = [];
  function getLastRenderedMessages() {
    return lastMessages;
  }

  const originalRender = render;
  render = function (messagesList) {
    lastMessages = messagesList;
    originalRender(messagesList);
  };

  updateSendState();
  vscode.postMessage({ type: "ready" });
})();
