import { afterEach, describe, expect, it } from "bun:test"
import { resolveModel, routableCodexModels } from "./model-allowlist.ts"

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
    expect(resolveModel("opus")).toBe("gpt-5.5")
    expect(resolveModel("claude-sonnet-5")).toBe("gpt-5.4")
    expect(resolveModel("claude-opus-4-8")).toBe("gpt-5.5")
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
    expect(resolveModel("opus")).toBe("gpt-5.5")
  })

  it("allows arbitrary alias keys and target model strings", () => {
    delete process.env.CCP_CODEX_MODEL
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({
      random: "gpt-5.6-sol",
      opus: "gpt-5.2",
    })
    expect(resolveModel("random")).toBe("gpt-5.6-sol")
    expect(resolveModel("opus")).toBe("gpt-5.2")
  })

  it("ignores non-string and empty alias entries", () => {
    delete process.env.CCP_CODEX_MODEL
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({
      random: 123,
      "": "gpt-5.6-sol",
      opus: "",
    })
    expect(resolveModel("random")).toBe("random")
    expect(resolveModel("opus")).toBe("gpt-5.5")
  })

  it("keeps CCP_CODEX_MODEL precedence", () => {
    process.env.CCP_CODEX_MODEL = "gpt-5.6-sol"
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({ opus: "gpt-5.4" })
    expect(resolveModel("opus")).toBe("gpt-5.6-sol")
  })

  it("routes configured custom aliases", () => {
    delete process.env.CCP_CODEX_MODEL
    process.env.CCP_CODEX_MODEL_ALIASES = JSON.stringify({
      "claude-sonnet-5-custom": "gpt-5.6-sol",
    })
    expect(routableCodexModels().has("claude-sonnet-5-custom")).toBe(true)
  })
})
