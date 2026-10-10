(function () {
  const { renderMarkdown } = require("./markdown");
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const emptyStateEl = document.getElementById("empty-state");
  const inputEl = document.getElementById("input");
  const chipsEl = document.getElementById("context-chips");
  const chipEl = document.getElementById("editor-chip");
  const chipLabelEl = document.getElementById("editor-chip-label");
  const chipCloseEl = document.getElementById("editor-chip-close");
  const changesChipEl = document.getElementById("changes-chip");
  const sendBtn = document.getElementById("send-btn");
  const clearBtn = document.getElementById("clear-btn");
  const cancelBtn = document.getElementById("cancel-btn");
  const newChatBtn = document.getElementById("new-chat-btn");
  const chatSelect = document.getElementById("chat-select");
  const attachBtn = document.getElementById("attach-btn");
  const fileInput = document.getElementById("file-input");
  const attachmentsEl = document.getElementById("attachments");

  const maxImages = 4;
  const maxImageDim = 1600;
  let attachments = [];

  let thinking = false;
  let editorCtx = null;
  let ctxAttached = false;
  let ctxKey = "";
  let thinkingStatus = "SaMo is thinking";
  let streamPreviewText = "";

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
    emptyStateEl.hidden = messagesList.length !== 0;

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

      if (message.role === "user" && Array.isArray(message.images) && message.images.length) {
        const gallery = document.createElement("div");
        gallery.className = "message-images";
        for (const src of message.images) {
          const img = document.createElement("img");
          img.src = src;
          img.alt = "Attached screenshot";
          gallery.appendChild(img);
        }
        bubble.appendChild(gallery);
      }

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

      if (message.role === "assistant" && message.changeSet) {
        const cs = message.changeSet;
        const makeBtn = (label, cls, type) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `fix-btn ${cls}`;
          btn.textContent = label;
          btn.disabled = thinking;
          btn.addEventListener("click", () => vscode.postMessage({ type, id: cs.id }));
          return btn;
        };
        if (cs.status === "applied") {
          const actions = document.createElement("div");
          actions.className = "fix-actions";
          actions.appendChild(makeBtn("Undo", "keep", "undoChangeSet"));
          actions.appendChild(makeBtn("Keep changes", "apply", "keepChangeSet"));
          row.appendChild(actions);
        } else if (cs.status === "kept") {
          const state = document.createElement("div");
          state.className = "fix-state";
          state.textContent = cs.prUrl ? "Changes kept. Pull request created." : "Changes kept.";
          row.appendChild(state);
        } else if (cs.status === "undone") {
          const state = document.createElement("div");
          state.className = "fix-state";
          state.textContent = "Changes undone.";
          row.appendChild(state);
        }
      }

      messagesEl.appendChild(row);
    });

    if (thinking && streamPreviewText) {
      const row = document.createElement("div");
      row.className = "message assistant stream-preview";
      const avatar = document.createElement("div");
      avatar.className = "bubble-avatar";
      avatar.textContent = "S";
      const bubble = document.createElement("div");
      bubble.className = "bubble markdown-body";
      bubble.innerHTML = renderMarkdown(streamPreviewText);
      row.appendChild(avatar);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
    }

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

  function renderChip() {
    if (!editorCtx) {
      chipsEl.hidden = true;
      return;
    }
    const range = editorCtx.hasSelection
      ? editorCtx.startLine === editorCtx.endLine
        ? `:${editorCtx.startLine}`
        : `:${editorCtx.startLine}-${editorCtx.endLine}`
      : "";
    chipLabelEl.textContent = `${editorCtx.name}${range}`;
    chipEl.title = editorCtx.hasSelection
      ? `Selected lines in ${editorCtx.path}${range ? ` (${range.slice(1)})` : ""} will be sent to SaMo`
      : `${editorCtx.path} — click to ${ctxAttached ? "detach from" : "attach to"} this message`;
    chipEl.classList.toggle("attached", ctxAttached);
    chipEl.classList.toggle("selection", Boolean(editorCtx.hasSelection));
    chipsEl.hidden = editorCtx.hasSelection ? !ctxAttached : false;
  }

  function setEditorContext(context) {
    editorCtx = context || null;
    if (!editorCtx) {
      ctxKey = "";
      ctxAttached = false;
    } else {
      const key = `${editorCtx.path}|${editorCtx.startLine || ""}|${editorCtx.endLine || ""}`;
      if (key !== ctxKey) {
        ctxKey = key;
        ctxAttached = Boolean(editorCtx.hasSelection);
      }
    }
    renderChip();
  }

  function renderChanges(messagesList) {
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const message of messagesList) {
      const cs = message.changeSet;
      if (cs && cs.status === "applied") {
        files += cs.files.length;
        added += cs.added || 0;
        removed += cs.removed || 0;
      }
    }
    if (!files) {
      changesChipEl.hidden = true;
      return;
    }
    changesChipEl.hidden = false;
    changesChipEl.innerHTML = `<span class="chip-files">${files} ${files === 1 ? "File" : "Files"}</span> <span class="plus">+${added}</span> <span class="minus">-${removed}</span>`;
  }

  chipEl.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".chip-close")) return;
    if (!editorCtx) return;
    ctxAttached = !ctxAttached;
    renderChip();
  });
  chipCloseEl.addEventListener("click", () => {
    ctxAttached = false;
    renderChip();
  });
  changesChipEl.addEventListener("click", () => {
    const rows = messagesEl.querySelectorAll(".fix-actions");
    const last = rows[rows.length - 1];
    if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  function autoResize() {
    inputEl.rows = Math.max(1, Math.min(6, inputEl.value.split(/\r?\n/).length));
  }

  function updateSendState() {
    sendBtn.disabled = thinking || (inputEl.value.trim().length === 0 && attachments.length === 0);
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachmentsEl.hidden = attachments.length === 0;
    attachments.forEach((src, index) => {
      const item = document.createElement("span");
      item.className = "attachment";
      const img = document.createElement("img");
      img.src = src;
      img.alt = `Attachment ${index + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.title = "Remove image";
      remove.textContent = "\u00d7";
      remove.addEventListener("click", () => {
        attachments.splice(index, 1);
        renderAttachments();
        updateSendState();
      });
      item.appendChild(img);
      item.appendChild(remove);
      attachmentsEl.appendChild(item);
    });
  }

  function readImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const scale = Math.min(1, maxImageDim / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files) {
    for (const file of files) {
      if (attachments.length >= maxImages) break;
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) continue;
      const dataUrl = await readImage(file);
      if (dataUrl) attachments.push(dataUrl);
    }
    renderAttachments();
    updateSendState();
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    void addImages(Array.from(fileInput.files || []));
    fileInput.value = "";
  });
  inputEl.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      void addImages(files);
    }
  });
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    void addImages(Array.from(event.dataTransfer?.files || []));
  });

  function send() {
    const typed = inputEl.value.trim();
    if ((!typed && !attachments.length) || thinking) return;
    const text = typed || "Look at the attached screenshot and fix the problem it shows.";
    const images = attachments.slice();
    thinking = true;
    thinkingStatus = "SaMo is thinking";
    streamPreviewText = "";
    render([
      ...getLastRenderedMessages(),
      { role: "user", text, ...(images.length ? { images } : {}) },
    ]);
    updateSendState();
    vscode.postMessage({
      type: "sendMessage",
      text,
      includeEditorContext: Boolean(editorCtx) && ctxAttached,
      images,
    });
    attachments = [];
    renderAttachments();
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
  cancelBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
  newChatBtn.addEventListener("click", () => vscode.postMessage({ type: "newConversation" }));
  chatSelect.addEventListener("change", () => {
    if (chatSelect.value) vscode.postMessage({ type: "switchConversation", id: chatSelect.value });
  });

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
        clipboardInput.className = "clipboard-fallback";
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
    if (message.type === "editorContext") {
      setEditorContext(message.context);
    } else if (message.type === "history") {
      render(message.messages);
      renderChanges(message.messages);
    } else if (message.type === "sessions") {
      chatSelect.replaceChildren();
      for (const session of message.sessions || []) {
        const option = document.createElement("option");
        option.value = session.id;
        const date = new Date(session.updatedAt);
        const timeLabel = Number.isNaN(date.getTime())
          ? ""
          : ` · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        option.textContent = `${session.title || "New chat"}${timeLabel}`;
        option.title = `${session.messageCount || 0} messages`;
        chatSelect.appendChild(option);
      }
      chatSelect.value = message.activeId || "";
    } else if (message.type === "thinking") {
      thinking = Boolean(message.value);
      cancelBtn.hidden = !thinking;
      if (!thinking) {
        thinkingStatus = "SaMo is thinking";
        streamPreviewText = "";
      }
      updateSendState();
      render(getLastRenderedMessages());
    } else if (message.type === "status") {
      thinkingStatus = String(message.text ?? "SaMo is working");
      render(getLastRenderedMessages());
    } else if (message.type === "streamPreview") {
      streamPreviewText = String(message.text ?? "");
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
