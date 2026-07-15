# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`claude-code-proxy` is a Bun HTTP proxy that lets Claude Code talk to non-Anthropic backends. It accepts Anthropic Messages API requests from Claude Code and translates them to either:

- Codex / ChatGPT Responses API
- Kimi Code chat-completions API

The proxy handles model-based provider routing, OAuth token management, request/response translation, SSE streaming, tool calls, and thinking/reasoning blocks.

There is also a separate Electron tray app under `tray/` that starts/stops the proxy, manages Codex-oriented settings, and tails the proxy log.

## Commands

### Root project

```bash
# Run the proxy locally (default port 18765)
bun run src/cli.ts serve

# Type-check the root project
bun typecheck

# Run a single Bun test file
bun test src/providers/codex/translate/request.test.ts
bun test src/providers/codex/translate/model-allowlist.test.ts

# Build a standalone binary
bun build ./src/cli.ts --compile --outfile ~/.local/bin/claude-code-proxy

# Provider auth commands
bun run src/cli.ts codex auth login
bun run src/cli.ts codex auth device
bun run src/cli.ts codex auth status
bun run src/cli.ts codex auth logout
bun run src/cli.ts kimi auth login
bun run src/cli.ts kimi auth status
bun run src/cli.ts kimi auth logout

# Watch proxy logs
tail -f ~/.local/state/claude-code-proxy/proxy.log | jq .
```

### Tray app (`tray/`)

```bash
cd tray
npm run build   # compile Electron app to tray/dist
npm run dev     # build and launch locally
npm run dist    # build portable Windows distribution
```

## Runtime architecture

```text
Claude Code
  └─ POST /v1/messages or /v1/messages/count_tokens
      └─ src/server.ts
          ├─ parses Anthropic request
          ├─ chooses provider from request.model
          ├─ builds RequestContext (reqId, sessionId, sessionSeq, logger, abort signal)
          └─ dispatches to provider.handleMessages / handleCountTokens
                └─ src/providers/<provider>/index.ts
                    ├─ translate/request.ts
                    ├─ client.ts
                    ├─ translate/stream.ts
                    ├─ translate/reducer.ts
                    └─ translate/accumulate.ts
                          └─ Anthropic-compatible SSE or JSON response
```

### Core files

- `src/cli.ts` — CLI entrypoint for `serve`, auth subcommands, and version output.
- `src/server.ts` — Bun server, `/v1/messages`, `/v1/messages/count_tokens`, `/healthz`, request logging, provider dispatch.
- `src/providers/registry.ts` — provider registry and model-name → provider lookup.
- `src/providers/types.ts` — `Provider` and `RequestContext` interfaces.
- `src/anthropic/schema.ts` — Anthropic request/response types accepted by the proxy.
- `src/sse.ts` — SSE parse/encode helpers shared by stream translators.
- `src/log.ts` — JSON-lines logging, secret redaction, 20 MiB rotation.

### Provider layout

Each provider lives in `src/providers/<name>/` and follows the same split:

- `index.ts` — implements the `Provider` interface and CLI auth handlers.
- `client.ts` — upstream HTTP client and token refresh behavior.
- `count-tokens.ts` — local token counting for Anthropic `count_tokens` requests.
- `translate/request.ts` — Anthropic request → upstream request translation.
- `translate/stream.ts` — upstream SSE → Anthropic SSE translation.
- `translate/reducer.ts` — normalizes raw upstream events into typed reducer events.
- `translate/accumulate.ts` — non-streaming path built on the same reducer logic.
- `auth/` — provider-specific OAuth flow and token persistence.

## Important architecture details

### Provider routing is model-driven

The server does not choose a provider from a config file or URL path. It routes every request by `body.model` via `src/providers/registry.ts`. Unknown model ids return HTTP 400 with the supported model list.

When debugging routing issues, check both:

- the requested `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`
- the provider allowlist / alias resolution in `translate/model-allowlist.ts`

### `count_tokens` is local

`POST /v1/messages/count_tokens` does not call upstream. Each provider translates the Anthropic request and estimates tokens locally, which Claude Code uses for compaction behavior.

### Streaming and non-streaming share reducer logic

The streaming path and non-streaming path both go through the provider reducer/accumulator pipeline. If a streamed response is wrong, inspect:

- `translate/stream.ts`
- `translate/reducer.ts`
- `translate/accumulate.ts`

rather than treating them as separate implementations.

### Session metadata is important

`src/server.ts` captures `x-claude-code-session-id` and creates `sessionSeq`. Providers use session information for logging and request shaping. Codex also forwards the session id into upstream headers, and translators may use it for prompt cache keys.

### Auth refresh is single-flight

Both providers refresh expiring tokens through shared auth-manager logic so concurrent requests do not stampede refresh endpoints. If auth looks flaky under concurrency, inspect provider `auth/manager.ts` and `client.ts` before changing request translation.

## Provider-specific behavior

### Codex

- Upstream is the ChatGPT/Codex Responses API.
- Accepts several concrete model ids plus aliases resolved in `translate/model-allowlist.ts`.
- `output_config.effort` is translated into a Codex `reasoning` block.
- Codex reasoning is requested when enabled but not forwarded back to Claude Code as Anthropic thinking blocks.
- Browser PKCE login and device-code login are both supported.
- The client forwards `session_id`, `x-client-request-id`, and `x-codex-window-id` headers when Claude Code provides a session id.

### Kimi

- Upstream is Kimi's OpenAI-style `/chat/completions` API.
- Supported wire model is `kimi-for-coding`; aliases such as `kimi-k2.6` / `k2.6` resolve to it.
- `output_config.effort` maps to Kimi `reasoning_effort`.
- Kimi reasoning/thinking content is forwarded back to Claude Code as Anthropic thinking blocks.
- Auth is device-code only.
- A persistent device id is stored at `~/.config/claude-code-proxy/kimi/device_id` and reused across sessions.

## Logging and debugging

- Logs are written to `$XDG_STATE_HOME/claude-code-proxy/proxy.log` or `~/.local/state/claude-code-proxy/proxy.log`.
- `CCP_LOG_STDERR=1` mirrors log lines to stderr while running.
- `CCP_LOG_VERBOSE=1` logs request/response bodies and SSE details.
- `src/log.ts` redacts secrets like bearer tokens, refresh tokens, auth codes, and `ChatGPT-Account-Id` before writing logs.
- The server exposes `GET /healthz` for liveness checks.

## Environment variables relevant during development

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `18765` | Proxy listen port |
| `XDG_STATE_HOME` | `~/.local/state` | Base directory for `proxy.log` |
| `CCP_LOG_STDERR` | unset | Mirror logs to stderr |
| `CCP_LOG_VERBOSE` | unset | Log full request/response bodies and SSE events |
| `KIMI_OAUTH_HOST` | `https://auth.kimi.com` | Override Kimi OAuth host |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding/v1` | Override Kimi API base URL |
| `CCP_CODEX_MODEL` | unset | Force Codex requests to a specific upstream model |
| `CCP_CODEX_EFFORT` | unset | Force Codex reasoning effort |
| `CCP_INSECURE_TLS` | unset | Allow insecure TLS when debugging behind SSL-inspecting proxies/VPNs |

## Tray app notes

The `tray/` directory is a separate Electron application, not a thin wrapper around the root CLI.

Important files there:

- `tray/src/main.ts` — Electron main process, tray menu, proxy lifecycle, Codex login/logout, log tailing.
- `tray/src/proxy.ts` — starts/stops the bundled proxy process.
- `tray/src/settings.ts` — manages tray-side mode/alias settings.

The tray app bundles the root proxy source as an extra resource for packaged builds, so changes to root runtime behavior can affect tray packaging and startup too.

## Suggested improvements made over the previous CLAUDE.md

The existing file was already strong. The main gaps were:

- adding the tray app as a first-class part of the repo
- documenting that routing is driven by `request.model`
- calling out `count_tokens`, reducer sharing, and session-id propagation as key debugging concepts
- including the extra Codex development env vars from `README.md`
- adding the tray build/dev commands alongside the root Bun commands
