/**
 * OpenAI wire fixtures for replay with `@yolk-sdk/conformance/replay`, and the conformance cases
 * they back for `@yolk-sdk/conformance/runner`: OpenAI Chat Completions (the generic
 * OpenAI-compatible chat provider) and the ChatGPT Codex Responses endpoint (the Codex
 * subscription provider).
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * OpenAI Chat Completions (including a reasoning model) and Responses wires; live probes replace them with verified recordings
 * (`pnpm conformance:openai`; `pnpm conformance:codex`, subscription OAuth, owner approval
 * required).
 *
 * Also exports the Codex subscription-usage case and fixture (`openAiCodexUsageSnapshotCase`,
 * `OpenAiCodexUsageConformanceConfig`; `pnpm conformance:usage --family codex`), kept apart from
 * the Responses cases.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  OpenAiConformanceConfig,
  openAiChatErrorEnvelopeCase,
  openAiChatJsonPlainTextCase,
  openAiChatJsonReasoningUsageCase,
  openAiChatPlainTextCase,
  openAiChatReasoningEffortCase,
  openAiChatToolCallDeltasCase,
  openAiChatUnsupportedParameterCase,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  type OpenAiConformanceCase,
  type OpenAiConformanceModels,
  type OpenAiConformanceRequirements,
  type OpenAiConformanceSettings
} from './cases.ts'
import {
  OpenAiCodexConformanceConfig,
  openAiCodexConformanceCases,
  openAiCodexConformanceDefaultModels,
  openAiCodexConformanceResponsesUrl,
  openAiCodexErrorEnvelopeCase,
  openAiCodexFunctionCallArgumentsCase,
  openAiCodexPlainTextCase,
  openAiCodexTerminalEventCase,
  type OpenAiCodexConformanceCase,
  type OpenAiCodexConformanceModels,
  type OpenAiCodexConformanceRequirements,
  type OpenAiCodexConformanceSettings
} from './codex-cases.ts'
import { openAiCodexErrorEnvelopeFixture } from './codex-error-envelope.ts'
import { openAiCodexFunctionCallArgumentsFixture } from './codex-function-call-arguments.ts'
import { openAiCodexPlainTextFixture } from './codex-plain-text.ts'
import { openAiCodexTerminalEventFixture } from './codex-terminal-event.ts'
import {
  OpenAiCodexUsageConformanceConfig,
  openAiCodexUsageConformanceCases,
  openAiCodexUsageConformanceUrl,
  openAiCodexUsageSnapshotCase,
  type OpenAiCodexUsageConformanceCase,
  type OpenAiCodexUsageConformanceRequirements,
  type OpenAiCodexUsageConformanceSettings
} from './codex-usage-cases.ts'
import { openAiCodexUsageSnapshotFixture } from './codex-usage-snapshot.ts'
import { openAiChatErrorEnvelopeFixture } from './error-envelope.ts'
import { openAiChatJsonPlainTextFixture } from './json-plain-text.ts'
import { openAiChatJsonReasoningUsageFixture } from './json-reasoning-usage.ts'
import { openAiChatPlainTextFixture } from './plain-text.ts'
import { openAiChatReasoningEffortFixture } from './reasoning-effort.ts'
import { openAiChatToolCallDeltasFixture } from './tool-call-deltas.ts'
import { openAiChatUnsupportedParameterFixture } from './unsupported-parameter.ts'

export {
  OpenAiConformanceConfig,
  openAiChatErrorEnvelopeCase,
  openAiChatJsonPlainTextCase,
  openAiChatJsonReasoningUsageCase,
  openAiChatPlainTextCase,
  openAiChatReasoningEffortCase,
  openAiChatToolCallDeltasCase,
  openAiChatUnsupportedParameterCase,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  type OpenAiConformanceCase,
  type OpenAiConformanceModels,
  type OpenAiConformanceRequirements,
  type OpenAiConformanceSettings,
  openAiChatErrorEnvelopeFixture,
  openAiChatJsonPlainTextFixture,
  openAiChatJsonReasoningUsageFixture,
  openAiChatPlainTextFixture,
  openAiChatReasoningEffortFixture,
  openAiChatToolCallDeltasFixture,
  openAiChatUnsupportedParameterFixture,
  OpenAiCodexConformanceConfig,
  openAiCodexConformanceCases,
  openAiCodexConformanceDefaultModels,
  openAiCodexConformanceResponsesUrl,
  openAiCodexErrorEnvelopeCase,
  openAiCodexFunctionCallArgumentsCase,
  openAiCodexPlainTextCase,
  openAiCodexTerminalEventCase,
  type OpenAiCodexConformanceCase,
  type OpenAiCodexConformanceModels,
  type OpenAiCodexConformanceRequirements,
  type OpenAiCodexConformanceSettings,
  openAiCodexErrorEnvelopeFixture,
  openAiCodexFunctionCallArgumentsFixture,
  openAiCodexPlainTextFixture,
  openAiCodexTerminalEventFixture,
  OpenAiCodexUsageConformanceConfig,
  openAiCodexUsageConformanceCases,
  openAiCodexUsageConformanceUrl,
  openAiCodexUsageSnapshotCase,
  type OpenAiCodexUsageConformanceCase,
  type OpenAiCodexUsageConformanceRequirements,
  type OpenAiCodexUsageConformanceSettings,
  openAiCodexUsageSnapshotFixture
}

/** Every OpenAI chat wire fixture, for replaying a whole conformance suite at once. */
export const openAiConformanceFixtures: ReadonlyArray<WireFixture> = [
  openAiChatPlainTextFixture,
  openAiChatToolCallDeltasFixture,
  openAiChatErrorEnvelopeFixture,
  openAiChatJsonPlainTextFixture,
  openAiChatReasoningEffortFixture,
  openAiChatJsonReasoningUsageFixture,
  openAiChatUnsupportedParameterFixture
]

/** Every Codex Responses wire fixture, for replaying the Codex conformance suite at once. */
export const openAiCodexConformanceFixtures: ReadonlyArray<WireFixture> = [
  openAiCodexPlainTextFixture,
  openAiCodexFunctionCallArgumentsFixture,
  openAiCodexErrorEnvelopeFixture,
  openAiCodexTerminalEventFixture
]

/** Every Codex subscription-usage wire fixture. */
export const openAiCodexUsageConformanceFixtures: ReadonlyArray<WireFixture> = [
  openAiCodexUsageSnapshotFixture
]
