/**
 * OpenAI Chat Completions wire fixtures for replay with `@yolk-sdk/conformance/replay`, and the
 * conformance cases they back for `@yolk-sdk/conformance/runner`.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * OpenAI Chat Completions wire; a live probe replaces them with verified recordings.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  OpenAiConformanceConfig,
  openAiChatErrorEnvelopeCase,
  openAiChatJsonPlainTextCase,
  openAiChatPlainTextCase,
  openAiChatToolCallDeltasCase,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  type OpenAiConformanceCase,
  type OpenAiConformanceModels,
  type OpenAiConformanceRequirements,
  type OpenAiConformanceSettings
} from './cases.ts'
import { openAiChatErrorEnvelopeFixture } from './error-envelope.ts'
import { openAiChatJsonPlainTextFixture } from './json-plain-text.ts'
import { openAiChatPlainTextFixture } from './plain-text.ts'
import { openAiChatToolCallDeltasFixture } from './tool-call-deltas.ts'

export {
  OpenAiConformanceConfig,
  openAiChatErrorEnvelopeCase,
  openAiChatJsonPlainTextCase,
  openAiChatPlainTextCase,
  openAiChatToolCallDeltasCase,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  type OpenAiConformanceCase,
  type OpenAiConformanceModels,
  type OpenAiConformanceRequirements,
  type OpenAiConformanceSettings,
  openAiChatErrorEnvelopeFixture,
  openAiChatJsonPlainTextFixture,
  openAiChatPlainTextFixture,
  openAiChatToolCallDeltasFixture
}

/** Every OpenAI chat wire fixture, for replaying a whole conformance suite at once. */
export const openAiConformanceFixtures: ReadonlyArray<WireFixture> = [
  openAiChatPlainTextFixture,
  openAiChatToolCallDeltasFixture,
  openAiChatErrorEnvelopeFixture,
  openAiChatJsonPlainTextFixture
]
