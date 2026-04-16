# WebChat Overlay

WebChat Overlay is a Chrome extension + local Python API that adds a floating assistant to any webpage.
It answers questions using page context, can trigger helpful page actions, and optionally uses web search.

https://www.youtube.com/watch?v=ZG4TR8SZWNk

[![WebChat Demo](https://github.com/user-attachments/assets/05fd4ee9-b272-4a3f-846f-b38f776fd86e)](https://www.youtube.com/watch?v=ZG4TR8SZWNk)

## How It Works

1. The extension injects a floating chat widget into pages (`content.js` + `styles.css`).
2. When a user sends a message, the content script:
   - builds a page snapshot (title, URL, headings, relevant text blocks, possible actions)
   - detects whether the question likely needs live web information
3. The content script sends a runtime message to the service worker (`background.js`).
4. The service worker forwards the request to the local API (`POST /api/chat`).
5. The local API (`local_api.py`) builds model messages with page context and chooses providers:
   - uses Ollama first
   - falls back to OpenAI if Ollama fails/timeouts and an API key is configured
6. The response is returned to the extension, which renders:
   - assistant reply
   - source links (when OpenAI web search returns citations)
   - optional action chips (open links / click matching page controls)

## Components And Purpose

### Extension

- `extension/manifest.json`
  - Chrome extension manifest (MV3)
  - registers service worker, content script, styles, and local API host permissions
- `extension/background.js`
  - listens for `webchat:chat` messages from the content script
  - proxies chat payload to `http://127.0.0.1:8765/api/chat`
  - normalizes API success/error responses
- `extension/content.js`
  - injects and manages the in-page chat UI
  - tracks conversation state
  - extracts relevant page context and candidate actions
  - detects search/action intent and sends requests through the background worker
  - renders replies, sources, and quick action buttons
- `extension/styles.css`
  - all visual styles for the floating button, panel, message list, status area, and action chips

### Local Server

- `server/local_api.py`
  - lightweight HTTP server with CORS support
  - validates request payloads and orchestrates model calls
  - builds prompt/messages with page context
  - handles provider routing: Ollama primary, OpenAI fallback
  - returns reply text, provider info, and optional source citations
- `server/.env`
  - runtime configuration (host/port, provider model names, timeouts, API keys, web search toggle)
- `server/.env.example`
  - template showing required/optional environment values
- `server/requirements.txt`
  - Python dependencies for running the local server

## Project Structure

```text
demo-codex/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── styles.css
├── server/
│   ├── local_api.py
│   ├── requirements.txt
│   ├── .env
│   ├── .env.example
│   └── .venv/
└── README.md
```

## Run Locally

### 1) Start the local API

```bash
cd /Users/pardhuvarma/Downloads/demo-codex/server
source .venv/bin/activate
python local_api.py
```

### 2) Load the extension in Chrome

Load unpacked extension from:

`/Users/pardhuvarma/Downloads/demo-codex/extension`

## Provider Configuration

Edit:

`/Users/pardhuvarma/Downloads/demo-codex/server/.env`

Common values:

- `OLLAMA_MODEL=minimax-m2.7:cloud`
- `OPENAI_API_KEY=`
- `OPENAI_MODEL=<required when OPENAI_API_KEY is set>`
- `OPENAI_ENABLE_WEB_SEARCH=1`

Behavior:

- If `OPENAI_API_KEY` is empty, only Ollama is used.
- If `OPENAI_API_KEY` is set, the server tries Ollama first and falls back to OpenAI on failure.
- If the user asks a clearly web-oriented question and web search is enabled, OpenAI may be used with web search tools.

## Notes

- Page context is included with each message to improve page-specific answers.
- OpenAI integration uses the Responses API.
- Official docs: [GPT-4.1 mini](https://platform.openai.com/docs/models/gpt-4.1-mini), [Responses API](https://platform.openai.com/docs/api-reference/responses/retrieve)
