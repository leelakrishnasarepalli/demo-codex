from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"


def load_env_file() -> None:
    if not ENV_PATH.exists():
        return

    for raw_line in ENV_PATH.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()

def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}. Set it in server/.env.")
    return value


def env_required_int(name: str) -> int:
    value = env_required(name)
    try:
        return int(value)
    except ValueError as error:
        raise RuntimeError(
            f"Environment variable {name} must be an integer. Got: {value!r}."
        ) from error


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip() not in {"0", "false", "False"}


API_HOST = env_required("WEBCHAT_API_HOST")
API_PORT = env_required_int("WEBCHAT_API_PORT")
OLLAMA_BASE_URL = env_required("OLLAMA_BASE_URL")
OLLAMA_MODEL = env_required("OLLAMA_MODEL")
OLLAMA_TIMEOUT_SECONDS = env_required_int("OLLAMA_TIMEOUT_SECONDS")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "").strip()
OPENAI_TIMEOUT_SECONDS = env_required_int("OPENAI_TIMEOUT_SECONDS")
OPENAI_ENABLE_WEB_SEARCH = env_bool("OPENAI_ENABLE_WEB_SEARCH", default=False)
SYSTEM_PROMPT = " ".join(
    [
        "You are a helpful assistant embedded in a browser extension.",
        "If page context is provided, use it for page-specific questions.",
        "If web search is enabled for the request, use it to answer internet or latest-information questions.",
        "When you refer to links, include markdown links when possible.",
        "Be concise and practical.",
    ]
)


class WebChatHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/api/chat":
            self._send_json(404, {"error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON payload."})
            return

        try:
            result = process_chat(payload)
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return
        except Exception as error:
            self._send_json(500, {"error": str(error)})
            return

        self._send_json(200, result)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def process_chat(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages")
    page_snapshot = payload.get("pageSnapshot") or None
    use_web_search = bool(payload.get("useWebSearch"))

    if not isinstance(messages, list) or not messages:
        raise ValueError("Messages are required.")

    if page_snapshot is not None and not isinstance(page_snapshot, dict):
        page_snapshot = None

    if use_web_search and OPENAI_API_KEY and OPENAI_ENABLE_WEB_SEARCH:
        return call_openai(messages, page_snapshot, use_web_search=True)

    try:
        reply = call_ollama(messages, page_snapshot)
        return {"reply": reply, "provider": "ollama", "sources": []}
    except Exception as ollama_error:
        if OPENAI_API_KEY:
            try:
                return call_openai(messages, page_snapshot, use_web_search=use_web_search)
            except Exception as openai_error:
                raise RuntimeError(
                    f"Ollama failed: {ollama_error}. OpenAI fallback failed: {openai_error}"
                ) from openai_error
        raise RuntimeError(str(ollama_error)) from ollama_error


def build_messages(messages: list[dict[str, Any]], page_snapshot: dict[str, Any] | None) -> list[dict[str, str]]:
    model_messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    dom_summary = ""
    if page_snapshot:
        dom_summary = str(page_snapshot.get("domSummary") or "").strip()

    last_user_index = None
    for index, message in enumerate(messages):
        if str(message.get("role") or "").strip() == "user":
            last_user_index = index

    for index, message in enumerate(messages):
        role = str(message.get("role") or "").strip()
        content = str(message.get("content") or "").strip()
        if role not in {"user", "assistant", "system"} or not content:
            continue

        if role == "user" and index == last_user_index and dom_summary:
            content = (
                "Use this browser page context if it helps answer the question. "
                "Pay special attention to the relevant sections and actions from the page.\n\n"
                f"<page_context>\n{dom_summary}\n</page_context>\n\n"
                f"User question: {content}"
            )

        model_messages.append({"role": role, "content": content})

    return model_messages


def call_ollama(messages: list[dict[str, Any]], page_snapshot: dict[str, Any] | None) -> str:
    request_body = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "stream": False,
            "messages": build_messages(messages, page_snapshot),
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/chat",
        data=request_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except TimeoutError as error:
        raise RuntimeError("timed out waiting for Ollama") from error
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Ollama request failed with status {error.code}. {detail}".strip()) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Could not reach Ollama: {error.reason}") from error

    content = ((payload.get("message") or {}).get("content") or "").strip()
    if not content:
        raise RuntimeError("Ollama returned an empty response.")
    return content


def extract_openai_sources(payload: dict[str, Any]) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    seen: set[str] = set()
    output = payload.get("output") or []

    for item in output:
      if item.get("type") != "message":
        continue
      for content in item.get("content") or []:
        for annotation in content.get("annotations") or []:
          if annotation.get("type") != "url_citation":
            continue
          url = str(annotation.get("url") or "").strip()
          if not url or url in seen:
            continue
          seen.add(url)
          sources.append({
            "url": url,
            "title": str(annotation.get("title") or url).strip()
          })
    return sources


def extract_openai_text(payload: dict[str, Any]) -> str:
    direct_text = str(payload.get("output_text") or "").strip()
    if direct_text:
        return direct_text

    text_parts: list[str] = []
    for item in payload.get("output") or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            content_type = str(content.get("type") or "").strip()
            if content_type in {"output_text", "text"}:
                value = str(content.get("text") or content.get("value") or "").strip()
                if value:
                    text_parts.append(value)

    return "\n".join(text_parts).strip()


def call_openai(messages: list[dict[str, Any]], page_snapshot: dict[str, Any] | None, *, use_web_search: bool) -> dict[str, Any]:
    if not OPENAI_MODEL:
        raise RuntimeError("OPENAI_MODEL is not set. Configure it in server/.env before using OpenAI fallback.")

    request_payload: dict[str, Any] = {
        "model": OPENAI_MODEL,
        "input": build_messages(messages, page_snapshot),
    }

    if use_web_search and OPENAI_ENABLE_WEB_SEARCH:
        request_payload["tools"] = [{"type": "web_search"}]
        request_payload["tool_choice"] = "auto"

    request_body = json.dumps(request_payload).encode("utf-8")

    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=OPENAI_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except TimeoutError as error:
        raise RuntimeError("timed out waiting for OpenAI") from error
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"OpenAI request failed with status {error.code}. {detail}".strip()) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Could not reach OpenAI: {error.reason}") from error

    content = extract_openai_text(payload)
    if not content:
        status = str(payload.get("status") or "unknown")
        incomplete_details = payload.get("incomplete_details")
        detail_suffix = f" status={status}"
        if incomplete_details:
            detail_suffix += f", incomplete_details={incomplete_details}"
        raise RuntimeError(f"OpenAI returned an empty response.{detail_suffix}")

    return {
        "reply": content,
        "provider": "openai",
        "sources": extract_openai_sources(payload)
    }


def main() -> None:
    server = ThreadingHTTPServer((API_HOST, API_PORT), WebChatHandler)
    print(f"WebChat local API listening on http://{API_HOST}:{API_PORT}")
    print(f"Primary provider: Ollama ({OLLAMA_MODEL})")
    openai_model_text = OPENAI_MODEL or "unset"
    print(f"OpenAI fallback: {'enabled' if OPENAI_API_KEY else 'disabled'} ({openai_model_text})")
    print(f"OpenAI web search: {'enabled' if OPENAI_ENABLE_WEB_SEARCH else 'disabled'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
