import { Layer, Logger } from 'effect'
import { Db } from './services/db/live-layer'
import { Auth } from './services/auth/live-layer'
import { AnthropicClaudeOAuth } from './services/anthropic-oauth/live-layer'
import { OpenAiCodexOAuth } from './services/openai-codex-oauth/live-layer'
import { TelemetryLayer } from './services/telemetry/live-layer'

// Combined app layer
export const AppLayer = Layer.mergeAll(
  Auth.layer,
  Db.layer,
  AnthropicClaudeOAuth.layer,
  OpenAiCodexOAuth.layer,
  Logger.layer([Logger.consolePretty()]),
  TelemetryLayer
)
