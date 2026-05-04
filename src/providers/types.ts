import type { AnthropicRequest } from "../anthropic/schema.ts"

import type { Logger } from "../log.ts"

export interface RequestContext {
  reqId: string
  sessionId?: string
  sessionSeq?: number
  signal: AbortSignal
  childLogger(service: string): Logger
}

export interface CliHandlers {
  login?: () => Promise<void>
  device?: () => Promise<void>
  status: () => Promise<void>
  logout: () => Promise<void>
}

export interface Provider {
  name: string
  // Request model identifiers this provider claims. The server uses these
  // to dispatch a request body's `model` field to the right provider when
  // multiple are registered. Some providers also claim shared aliases like
  // `haiku`/`sonnet`, so docs should prefer concrete provider-owned ids.
  supportedModels: Set<string>
  handleMessages(body: AnthropicRequest, ctx: RequestContext): Promise<Response>
  handleCountTokens(body: AnthropicRequest, ctx: RequestContext): Promise<Response>
  cli: CliHandlers
}
