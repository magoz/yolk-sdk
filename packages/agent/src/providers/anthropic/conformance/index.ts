/**
 * Anthropic Messages wire fixtures for replay with `@yolk-sdk/conformance/replay`, and the
 * conformance cases they back for `@yolk-sdk/conformance/runner`.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * Anthropic Messages wire; a live probe replaces them with verified recordings.
 *
 * Also exports the Claude subscription-usage case and fixture (`anthropicClaudeUsageSnapshotCase`,
 * `AnthropicClaudeUsageConformanceConfig`; `pnpm conformance:usage --family claude`, subscription
 * OAuth, owner approval required), kept apart from the Messages cases.
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
import {
  AnthropicClaudeUsageConformanceConfig,
  anthropicClaudeUsageConformanceCases,
  anthropicClaudeUsageConformanceUrl,
  anthropicClaudeUsageSnapshotCase,
  type AnthropicClaudeUsageConformanceCase,
  type AnthropicClaudeUsageConformanceRequirements,
  type AnthropicClaudeUsageConformanceSettings
} from './claude-usage-cases.ts'
import { anthropicClaudeUsageSnapshotFixture } from './claude-usage-snapshot.ts'
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
  anthropicMessagesToolUseInputDeltasFixture,
  AnthropicClaudeUsageConformanceConfig,
  anthropicClaudeUsageConformanceCases,
  anthropicClaudeUsageConformanceUrl,
  anthropicClaudeUsageSnapshotCase,
  type AnthropicClaudeUsageConformanceCase,
  type AnthropicClaudeUsageConformanceRequirements,
  type AnthropicClaudeUsageConformanceSettings,
  anthropicClaudeUsageSnapshotFixture
}

/** Every Anthropic Messages wire fixture, for replaying a whole conformance suite at once. */
export const anthropicConformanceFixtures: ReadonlyArray<WireFixture> = [
  anthropicMessagesPlainTextFixture,
  anthropicMessagesToolUseInputDeltasFixture,
  anthropicMessagesThinkingBeforeTextFixture,
  anthropicMessagesErrorEnvelopeFixture,
  anthropicMessagesMaxTokensFixture
]

/** Every Claude subscription-usage wire fixture. */
export const anthropicClaudeUsageConformanceFixtures: ReadonlyArray<WireFixture> = [
  anthropicClaudeUsageSnapshotFixture
]
