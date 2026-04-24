import { afterEach, describe, expect, it } from "bun:test"
import { resolveModel } from "./model-allowlist.ts"

const ORIGINAL = {
  CCP_CODEX_MODEL: process.env.CCP_CODEX_MODEL,
  CCP_CODEX_MODEL_ALIASES: process.env.CCP_CODEX_MODEL_ALIASES,
}

afterEach(() => {
  if (ORIGINAL.CCP_CODEX_MODEL === undefined) delete process.env.CCP_CODEX_MODEL
  else process.env.CCP_CODEX_MODEL = ORIGINAL.CCP_CODEX_MODEL

  if (ORIGINAL.CCP_CODEX_MODEL_ALIASES === undefined)
    delete process.env.CCP_CODEX_MODEL_ALIASES
  else process.env.CCP_CODEX_MODEL_ALIASES = ORIGINAL.CCP_CODEX_MODEL_ALIASES
})

describe("resolveModel", () => {
  it("uses default aliases", () => {
    delete process.env.CCP_CODEX_MODEL
    delete process.env.CCP_CODEX_MODEL_ALIASES
    expect(resolveModel("opus")).toBe("gpt-5.2")
  })

  it("allows per-alias overrides via CCP_CODEX_MODEL_ALIASES", () => {
    delete process.env.CCP_CODEX_MODEL
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({
      opus: "gpt-5.4",
      "claude-opus-4-7": "gpt-5.4",
    })
    expect(resolveModel("opus")).toBe("gpt-5.4")
    expect(resolveModel("claude-opus-4-7")).toBe("gpt-5.4")
  })

  it("ignores invalid JSON", () => {
    delete process.env.CCP_CODEX_MODEL
    process.env.CCP_CODEX_MODEL_ALIASES = "{"
    expect(resolveModel("opus")).toBe("gpt-5.2")
  })

  it("ignores unknown keys and invalid values", () => {
    delete process.env.CCP_CODEX_MODEL
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({
      random: "gpt-5.4",
      opus: "gpt-4.1",
    })
    expect(resolveModel("opus")).toBe("gpt-5.2")
  })

  it("keeps CCP_CODEX_MODEL precedence", () => {
    process.env.CCP_CODEX_MODEL = "gpt-5.3-codex"
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({ opus: "gpt-5.4" })
    expect(resolveModel("opus")).toBe("gpt-5.3-codex")
  })
})
