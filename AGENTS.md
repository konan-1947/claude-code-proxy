# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the Bun-based proxy CLI and HTTP server. Start with `src/cli.ts` and `src/server.ts`. Shared protocol code lives in `src/anthropic/`, SSE helpers in `src/sse.ts`, and logging in `src/log.ts`. Provider-specific logic is under `src/providers/<provider>/`, with `auth/`, `translate/`, `client.ts`, and `index.ts` grouped together.

`tray/` is a separate Electron tray application with its own `package.json`, `tsconfig.json`, `src/`, and `assets/`. Root-level `scripts/` contains install and publish helpers. `meta/` stores repository media.

## Build, Test, and Development Commands
- `bun run src/cli.ts serve` runs the proxy locally on the default port.
- `bun run src/cli.ts codex auth login` authenticates the Codex provider.
- `bun run src/cli.ts kimi auth login` authenticates the Kimi provider.
- `bun typecheck` runs strict TypeScript checks for the main project.
- `bun test src/providers/codex/translate/request.test.ts` runs the current Bun test suite.
- `cd tray; npm run build` compiles the Electron tray app to `tray/dist/`.
- `cd tray; npm run dev` builds and launches the tray app locally.

## Coding Style & Naming Conventions
Use TypeScript and keep `strict` and `noUncheckedIndexedAccess` compliance intact. Match the existing code style: 2-space indentation, double quotes, semicolons omitted, and explicit `.ts` import suffixes where already used. Keep files focused and colocate provider logic with its provider directory. Use descriptive lowercase directory names and filenames such as `token-store.ts`, `model-allowlist.ts`, and `request.test.ts`.

## Testing Guidelines
Tests use Bun's built-in test runner via `bun:test`. Add tests next to the code they cover using the `*.test.ts` pattern. Favor focused translator and reducer tests for request/response edge cases before broader integration coverage. There is no documented coverage gate, so new behavior should ship with at least targeted regression tests when practical.

## Commit & Pull Request Guidelines
Recent history uses short, imperative subjects, often with a scope prefix such as `feat:`, `kimi:`, or `readme:`. Keep commit messages specific to one change. For pull requests, include a concise summary, note affected provider or tray paths, list commands you ran, and attach screenshots only for `tray/` UI changes.

## Contributor Scope
Make only the requested change. Avoid unrelated refactors, new abstractions, or behavior changes outside the task.
