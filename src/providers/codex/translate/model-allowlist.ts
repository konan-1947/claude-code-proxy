export const CODEX_MODEL_SUGGESTIONS = new Set([
  "gpt-5.3-codex",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.2",
])

export const MODEL_ALIASES = new Map<string, string>([
  ["haiku", "gpt-5.4-mini"],
  ["claude-haiku-4-5", "gpt-5.4-mini"],
  ["claude-haiku-4-5-20251001", "gpt-5.4-mini"],
  ["sonnet", "gpt-5.4"],
  ["claude-sonnet-4-6", "gpt-5.4"],
  ["claude-sonnet-5", "gpt-5.4"],
  ["sonnet[1m]", "gpt-5.4"],
  ["best", "gpt-5.4"],
  ["fable", "gpt-5.4"],
  ["claude-fable-5", "gpt-5.4"],
  ["opus", "gpt-5.5"],
  ["claude-opus-4-7", "gpt-5.5"],
  ["claude-opus-4-8", "gpt-5.5"],
  ["opus[1m]", "gpt-5.5"],
  ["opusplan", "gpt-5.5"],
])

type AliasOverrides = Record<string, string>

export function parseAliasOverrides(raw: string | undefined): AliasOverrides {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const out: AliasOverrides = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") continue
      const key = k.trim()
      const value = v.trim()
      if (key === "" || value === "") continue
      out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function resolveModel(model: string): string {
  // The CCP_CODEX_MODEL environment variable overrides the model so that
  // regardless of whatever model is requested by the harness, the provided
  // model is always used.
  if (
    process.env.CCP_CODEX_MODEL !== undefined &&
    process.env.CCP_CODEX_MODEL !== ""
  ) {
    return process.env.CCP_CODEX_MODEL
  }

  const overrides = parseAliasOverrides(process.env.CCP_CODEX_MODEL_ALIASES)
  return overrides[model] ?? MODEL_ALIASES.get(model) ?? model
}

export function routableCodexModels(): Set<string> {
  return new Set([
    ...CODEX_MODEL_SUGGESTIONS,
    ...MODEL_ALIASES.keys(),
    ...Object.keys(parseAliasOverrides(process.env.CCP_CODEX_MODEL_ALIASES)),
  ])
}
