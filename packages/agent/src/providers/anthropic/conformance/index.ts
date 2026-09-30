/**
 * Anthropic Messages wire fixtures for replay with `@yolk-sdk/conformance/replay`, and the
 * conformance cases they back for `@yolk-sdk/conformance/runner`.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * Anthropic Messages wire; a live probe replaces them with verified recordings.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  AnthropicConformanceConfig,
  anthropicConformanceCases,
  anthropicConformanceDefaultModels,
  anthropicConformanceMessagesUrl,
  anthropicConformanceTruncatedMaxTokens,
  anthropicConformanceVersion,
  anthropicMessagesErrorEnvelopeCase,
  anthropicMessagesMaxTokensCase,
  anthropicMessagesPlainTextCase,
  anthropicMessagesThinkingBeforeTextCase,
  anthropicMessagesToolUseInputDeltasCase,
  type AnthropicConformanceCase,
  type AnthropicConformanceModels,
  type AnthropicConformanceRequirements,
  type AnthropicConformanceSettings
} from './cases.ts'
import { anthropicMessagesErrorEnvelopeFixture } from './error-envelope.ts'
import { anthropicMessagesMaxTokensFixture } from './max-tokens.ts'
import { anthropicMessagesPlainTextFixture } from './plain-text.ts'
import { anthropicMessagesThinkingBeforeTextFixture } from './thinking-before-text.ts'
import { anthropicMessagesToolUseInputDeltasFixture } from './tool-use-input-deltas.ts'

export {
  AnthropicConformanceConfig,
  anthropicConformanceCases,
  anthropicConformanceDefaultModels,
  anthropicConformanceMessagesUrl,
  anthropicConformanceTruncatedMaxTokens,
  anthropicConformanceVersion,
  anthropicMessagesErrorEnvelopeCase,
  anthropicMessagesMaxTokensCase,
  anthropicMessagesPlainTextCase,
  anthropicMessagesThinkingBeforeTextCase,
  anthropicMessagesToolUseInputDeltasCase,
  type AnthropicConformanceCase,
  type AnthropicConformanceModels,
  type AnthropicConformanceRequirements,
  type AnthropicConformanceSettings,
  anthropicMessagesErrorEnvelopeFixture,
  anthropicMessagesMaxTokensFixture,
  anthropicMessagesPlainTextFixture,
  anthropicMessagesThinkingBeforeTextFixture,
  anthropicMessagesToolUseInputDeltasFixture
}

/** Every Anthropic Messages wire fixture, for replaying a whole conformance suite at once. */
export const anthropicConformanceFixtures: ReadonlyArray<WireFixture> = [
  anthropicMessagesPlainTextFixture,
  anthropicMessagesToolUseInputDeltasFixture,
  anthropicMessagesThinkingBeforeTextFixture,
  anthropicMessagesErrorEnvelopeFixture,
  anthropicMessagesMaxTokensFixture
]
