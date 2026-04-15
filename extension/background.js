const API_BASE_URL = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "webchat:chat") {
    return false;
  }

  handleChatRequest(message.payload)
    .then((result) => {
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    });

  return true;
});

async function handleChatRequest(payload) {
  const response = await fetch(`${API_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const detail = data && data.error ? data.error : text || `HTTP ${response.status}`;
    throw new Error(detail);
  }

  if (!data || typeof data.reply !== "string" || !data.reply.trim()) {
    throw new Error("Local API returned an empty reply.");
  }

  return {
    reply: data.reply.trim(),
    provider: data.provider || "unknown",
    sources: Array.isArray(data.sources) ? data.sources : []
  };
}
