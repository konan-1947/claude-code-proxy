# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

An HTTP proxy that lets Claude Code talk to non-Anthropic backends (ChatGPT/Codex, Kimi Code). It translates the Anthropic Messages API protocol to/from each provider's native API, including SSE streaming, tool calls, and thinking blocks.

## Commands

```bash
# Run the proxy (default port 18765)
bun run src/cli.ts serve

# Type-check (no emit)
bun typecheck

# Run tests
bun test src/providers/codex/translate/request.test.ts

# Build a self-contained binary
bun build ./src/cli.ts --compile --outfile ~/.local/bin/claude-code-proxy

# Auth commands (per provider)
bun run src/cli.ts codex auth login    # PKCE browser flow
bun run src/cli.ts codex auth device   # device-code (headless)
bun run src/cli.ts kimi auth login     # device-code only

# View logs
tail -f ~/.local/state/claude-code-proxy/proxy.log | jq .
```

## Architecture

```
Claude Code (Anthropic Messages API)
        │  POST /v1/messages
        ▼
  src/server.ts          ← Bun HTTP server, builds RequestContext
        │  routes by model name
        ▼
  Provider (codex | kimi)
        │  translate request → upstream shape
        │  stream upstream SSE → ReducerEvents → Anthropic SSE
        ▼
  ChatGPT Responses API / Kimi API
```

**Core layers:**

- `src/server.ts` — HTTP server, request routing, `RequestContext` (sessionId, reqId, seqId)
- `src/providers/registry.ts` — Model-name → provider lookup
- `src/providers/types.ts` — `Provider` interface (`handleMessages`, `handleCountTokens`, CLI handlers)
- `src/anthropic/schema.ts` — All Anthropic request/response types
- `src/log.ts` — JSON-lines logger, secret redaction, 20 MiB rotation
- `src/sse.ts` — SSE parse/encode helpers

**Each provider under `src/providers/<name>/` has:**
- `index.ts` — Implements `Provider`; wires CLI sub-commands
- `client.ts` — HTTP client with OAuth token refresh (single-flight guard, 5-min expiry margin)
- `translate/request.ts` — Anthropic request → upstream shape
- `translate/stream.ts` — Upstream SSE → Anthropic SSE (calls reducer)
- `translate/reducer.ts` — Accumulates raw events into typed `ReducerEvent`s (text, tool_use, finish)
- `auth/` — OAuth flows + token storage (macOS Keychain or `~/.config/claude-code-proxy/<provider>/auth.json`)

## Key translation details

**Anthropic → upstream:**
- `system` content blocks joined as `instructions` string
- `tool_choice` maps to `auto` / `none` / `required` / named function
- `output_config.format.type: "json_schema"` → provider JSON schema output
- `output_config.effort` → Kimi `reasoning_effort` / Codex `reasoning` block

**Upstream → Anthropic SSE:**
- Text deltas → `content_block_delta` (`text_delta`)
- Tool calls → `content_block_start` + `content_block_delta` (`input_json_delta`) + `content_block_stop`
- Codex reasoning → **dropped** (not forwarded)
- Kimi reasoning → forwarded as Anthropic `thinking` blocks
- 429 / 5xx → `UpstreamStreamError` → SSE `error` event with appropriate Anthropic error type

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `18765` | Proxy listen port |
| `CCP_LOG_STDERR` | unset | Mirror logs to stderr |
| `CCP_LOG_VERBOSE` | unset | Log full request/response bodies + every SSE event |
| `XDG_STATE_HOME` | `~/.local/state` | Base dir for `proxy.log` |
| `KIMI_OAUTH_HOST` | `https://auth.kimi.com` | Override Kimi OAuth endpoint |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding/v1` | Override Kimi API endpoint |
| `CCP_INSECURE_TLS` | unset | Skip TLS cert verification (also honoured by `NODE_TLS_REJECT_UNAUTHORIZED=0`) — use when behind a corporate proxy/VPN doing SSL inspection |

## Pointing Claude Code at the proxy

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18765"
export ANTHROPIC_AUTH_TOKEN="unused"
export ANTHROPIC_MODEL="gpt-5.4"               # or "kimi-for-coding"
export ANTHROPIC_SMALL_FAST_MODEL="gpt-5.4-mini"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

## Implementation notes

- **Single-flight refresh:** `client.ts` in each provider uses a shared promise to prevent concurrent token-refresh races.
- **Tool arg sanitization:** The reducer strips `pages=""` from `Read` tool arguments (a debugging artifact in some Claude Code versions).
- **Non-streaming path:** Same reducer as streaming; events accumulate and are returned as a single JSON object.
- **Kimi device ID:** Persisted at `~/.config/claude-code-proxy/kimi/device_id` across sessions.
