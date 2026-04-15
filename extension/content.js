(() => {
  const ROOT_ID = "webchat-overlay-root";
  const state = {
    conversation: []
  };

  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "do", "i", "you",
    "me", "my", "this", "that", "it", "at", "as", "from", "by", "about", "what", "where", "when", "how", "who"
  ]);

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function tokenize(text) {
    return normalizeText(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token && token.length > 2 && !STOP_WORDS.has(token));
  }

  function getQueryTerms(question) {
    return Array.from(new Set(tokenize(question)));
  }

  function scoreText(text, queryTerms) {
    if (!text || !queryTerms.length) {
      return 0;
    }

    const haystack = normalizeText(text).toLowerCase();
    let score = 0;
    queryTerms.forEach((term) => {
      if (haystack.includes(term)) {
        score += 1;
      }
    });
    return score;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function createSelector(element) {
    if (!element || !(element instanceof Element)) {
      return "";
    }

    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }

    const parts = [];
    let current = element;
    let depth = 0;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 4) {
      let selector = current.tagName.toLowerCase();
      if (current.classList && current.classList.length) {
        selector += `.${cssEscape(current.classList[0])}`;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }

      parts.unshift(selector);
      current = parent;
      depth += 1;
    }

    return parts.join(" > ");
  }

  function detectSearchIntent(question) {
    return /\b(search|internet|web|online|look up|lookup|find online|latest|today|news|recent|current|price|weather|score|stocks?)\b/i.test(question);
  }

  function detectActionIntent(question) {
    return /\b(click|open|go to|visit|link|button|download|login|sign in|sign up|submit|apply|contact|start|next)\b/i.test(question);
  }

  function collectRelevantTextBlocks(queryTerms) {
    const nodes = Array.from(document.querySelectorAll("main h1, main h2, main h3, main h4, main p, main li, article h1, article h2, article h3, article h4, article p, article li, h1, h2, h3, h4, p, li"));
    const blocks = nodes
      .map((node) => ({
        text: normalizeText(node.innerText || node.textContent || ""),
        tag: node.tagName.toLowerCase()
      }))
      .filter((block) => block.text)
      .map((block) => ({
        ...block,
        score: scoreText(block.text, queryTerms)
      }));

    const prioritized = blocks
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.text.length - a.text.length;
      })
      .slice(0, 12);

    const selected = prioritized.filter((block, index) => block.score > 0 || index < 4);
    return selected.slice(0, 8);
  }

  function collectActions(queryTerms) {
    const candidates = Array.from(document.querySelectorAll("a[href], button, input[type='submit'], input[type='button']"))
      .map((element) => {
        const label = normalizeText(
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent ||
          element.value ||
          ""
        );
        if (!label) {
          return null;
        }

        return {
          type: element.tagName.toLowerCase() === "a" ? "link" : "button",
          label,
          href: element.tagName.toLowerCase() === "a" ? element.href : "",
          selector: createSelector(element),
          score: scoreText(label, queryTerms)
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.label.localeCompare(b.label);
      });

    return candidates.slice(0, 8);
  }

  function buildPageSnapshot(question) {
    const title = normalizeText(document.title);
    const url = window.location.href;
    const host = window.location.host;
    const queryTerms = getQueryTerms(question);
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => normalizeText(node.innerText || node.textContent || ""))
      .filter(Boolean)
      .slice(0, 12);
    const relevantBlocks = collectRelevantTextBlocks(queryTerms);
    const actions = collectActions(queryTerms);

    const domSummary = [
      title ? `Title: ${title}` : "",
      `URL: ${url}`,
      headings.length ? `Headings: ${headings.join(" | ")}` : "",
      relevantBlocks.length
        ? `Relevant page sections: ${relevantBlocks.map((block) => `[${block.tag}] ${block.text}`).join(" | ")}`
        : "",
      actions.length
        ? `Available actions: ${actions.map((action) => `${action.type}: ${action.label}${action.href ? ` -> ${action.href}` : ""}`).join(" | ")}`
        : ""
    ]
      .filter(Boolean)
      .join("\n");

    return {
      title,
      url,
      host,
      domSummary,
      actions,
      relevantBlocks: relevantBlocks.map((block) => ({ tag: block.tag, text: block.text }))
    };
  }

  function renderRichText(container, text) {
    container.textContent = "";
    const value = String(text || "");
    const regex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(value)) !== null) {
      const before = value.slice(lastIndex, match.index);
      if (before) {
        container.appendChild(document.createTextNode(before));
      }

      const link = document.createElement("a");
      link.href = match[2];
      link.textContent = match[1];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "webchat-inline-link";
      container.appendChild(link);
      lastIndex = regex.lastIndex;
    }

    const tail = value.slice(lastIndex);
    if (tail) {
      container.appendChild(document.createTextNode(tail));
    }
  }

  function init() {
    if (!document.body || document.getElementById(ROOT_ID)) {
      return;
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;

    const container = document.createElement("div");
    container.className = "webchat-container";

    const panel = document.createElement("section");
    panel.className = "webchat-panel";
    panel.setAttribute("aria-label", "WebChat panel");
    panel.hidden = true;

    const header = document.createElement("div");
    header.className = "webchat-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "webchat-title-wrap";

    const title = document.createElement("div");
    title.className = "webchat-title";
    title.textContent = "Pluto WebChat";

    const subtitle = document.createElement("div");
    subtitle.className = "webchat-subtitle";
    subtitle.textContent = "Page-aware + web-aware chat";

    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "webchat-close";
    closeButton.setAttribute("aria-label", "Close chat panel");
    closeButton.textContent = "X";

    header.appendChild(titleWrap);
    header.appendChild(closeButton);

    const messages = document.createElement("div");
    messages.className = "webchat-messages";

    const placeholder = document.createElement("div");
    placeholder.className = "webchat-placeholder";
    placeholder.textContent = "Leela, ask me anything about this page or search the web.";
    messages.appendChild(placeholder);

    const status = document.createElement("div");
    status.className = "webchat-status";
    status.hidden = true;

    const inputSection = document.createElement("div");
    inputSection.className = "webchat-input-section";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "webchat-input";
    input.placeholder = "Shout something...";
    input.setAttribute("aria-label", "Type a message");

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "webchat-send";
    sendButton.textContent = "Go";

    inputSection.appendChild(input);
    inputSection.appendChild(sendButton);

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(status);
    panel.appendChild(inputSection);

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "webchat-button";
    openButton.setAttribute("aria-label", "Open WebChat");
    openButton.textContent = "Pluto";

    function renderMessages() {
      messages.innerHTML = "";

      if (!state.conversation.length) {
        const empty = document.createElement("div");
        empty.className = "webchat-placeholder";
        empty.textContent = "Leela, ask me anything about this page or search the web.";
        messages.appendChild(empty);
        return;
      }

      state.conversation.forEach((entry) => {
        if (!entry || !entry.role || !entry.content) {
          return;
        }

        const message = document.createElement("div");
        message.className = `webchat-message webchat-message-${entry.role}`;
        if (entry.role === "assistant") {
          renderRichText(message, entry.content);
        } else {
          message.textContent = entry.content;
        }
        messages.appendChild(message);

        if (entry.sources && entry.sources.length) {
          const sourceList = document.createElement("div");
          sourceList.className = "webchat-sources";
          entry.sources.forEach((source) => {
            const sourceLink = document.createElement("a");
            sourceLink.href = source.url;
            sourceLink.target = "_blank";
            sourceLink.rel = "noopener noreferrer";
            sourceLink.className = "webchat-source-link";
            sourceLink.textContent = source.title || source.url;
            sourceList.appendChild(sourceLink);
          });
          messages.appendChild(sourceList);
        }

        if (entry.actions && entry.actions.length) {
          const actionList = document.createElement("div");
          actionList.className = "webchat-actions";
          entry.actions.forEach((action) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "webchat-action-chip";
            button.textContent = action.type === "link" ? `Open ${action.label}` : `Click ${action.label}`;
            button.addEventListener("click", () => {
              if (action.href) {
                window.open(action.href, "_blank", "noopener,noreferrer");
                return;
              }

              if (action.selector) {
                const target = document.querySelector(action.selector);
                if (target instanceof HTMLElement) {
                  target.scrollIntoView({ behavior: "smooth", block: "center" });
                  target.click();
                }
              }
            });
            actionList.appendChild(button);
          });
          messages.appendChild(actionList);
        }
      });

      messages.scrollTop = messages.scrollHeight;
    }

    function openPanel() {
      if (!panel.hidden) {
        return;
      }

      panel.hidden = false;
      panel.classList.add("webchat-panel-visible");
      requestAnimationFrame(() => {
        input.focus();
      });
    }

    function closePanel() {
      panel.hidden = true;
      panel.classList.remove("webchat-panel-visible");
      setBusy(false);
      hideStatus();
    }

    function hideStatus() {
      status.hidden = true;
      status.textContent = "";
      status.classList.remove("webchat-status-error");
    }

    function showStatus(text, isError) {
      status.textContent = text;
      status.hidden = false;
      status.classList.toggle("webchat-status-error", Boolean(isError));
      messages.scrollTop = messages.scrollHeight;
    }

    function setBusy(isBusy) {
      sendButton.disabled = isBusy;
      input.disabled = isBusy;
      sendButton.textContent = isBusy ? "..." : "Send";
    }

    function sendRuntimeMessage(payload) {
      return new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(response);
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    async function sendMessage() {
      const value = input.value.trim();
      if (!value || input.disabled) {
        return;
      }

      const searchIntent = detectSearchIntent(value);
      const pageSnapshot = buildPageSnapshot(value);
      const actionIntent = detectActionIntent(value);
      const suggestedActions = actionIntent ? pageSnapshot.actions.slice(0, 3) : [];

      state.conversation.push({ role: "user", content: value });
      renderMessages();
      input.value = "";
      setBusy(true);

      try {
        showStatus(searchIntent ? "Searching the web and checking the page..." : "Reading relevant parts of the page...", false);

        const response = await sendRuntimeMessage({
          type: "webchat:chat",
          payload: {
            messages: state.conversation,
            pageSnapshot,
            useWebSearch: searchIntent
          }
        });

        if (!response || !response.ok || !response.reply) {
          throw new Error(response && response.error ? response.error : "No reply received.");
        }

        state.conversation.push({
          role: "assistant",
          content: response.reply,
          sources: Array.isArray(response.sources) ? response.sources : [],
          actions: suggestedActions
        });
        renderMessages();
        hideStatus();
      } catch (error) {
        state.conversation.pop();
        renderMessages();
        showStatus(
          error instanceof Error ? `Unable to complete chat: ${error.message}` : "Unable to complete chat.",
          true
        );
      } finally {
        setBusy(false);
        input.focus();
      }
    }

    openButton.addEventListener("click", openPanel);
    closeButton.addEventListener("click", closePanel);
    sendButton.addEventListener("click", sendMessage);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendMessage();
      }
    });

    renderMessages();
    container.appendChild(panel);
    container.appendChild(openButton);
    root.appendChild(container);
    document.body.appendChild(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
