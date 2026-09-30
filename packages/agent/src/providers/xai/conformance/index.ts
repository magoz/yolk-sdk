/**
 * xAI Grok (CLI proxy) Responses wire fixtures for replay with `@yolk-sdk/conformance/replay`,
 * and the conformance cases they back for `@yolk-sdk/conformance/runner`.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * OpenAI Responses wire; a live probe (`pnpm conformance:grok`, subscription OAuth, owner approval
 * required) replaces them with verified recordings.
 *
 * Also exports the Grok subscription-usage case and fixture (`xAiGrokUsageSnapshotCase`,
 * `XAiGrokUsageConformanceConfig`; `pnpm conformance:usage --family grok`), kept apart from the
 * Responses cases.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  XAiGrokConformanceConfig,
  xAiGrokConformanceCases,
  xAiGrokConformanceDefaultModels,
  xAiGrokConformanceResponsesUrl,
  xAiGrokErrorEnvelopeCase,
  xAiGrokFunctionCallArgumentsCase,
  xAiGrokPlainTextCase,
  xAiGrokTerminalEventCase,
  type XAiGrokConformanceCase,
  type XAiGrokConformanceModels,
  type XAiGrokConformanceRequirements,
  type XAiGrokConformanceSettings
} from './cases.ts'
import { xAiGrokErrorEnvelopeFixture } from './error-envelope.ts'
import { xAiGrokFunctionCallArgumentsFixture } from './function-call-arguments.ts'
import { xAiGrokPlainTextFixture } from './plain-text.ts'
import { xAiGrokTerminalEventFixture } from './terminal-event.ts'
import {
  XAiGrokUsageConformanceConfig,
  xAiGrokUsageConformanceCases,
  xAiGrokUsageConformanceUrl,
  xAiGrokUsageSnapshotCase,
  type XAiGrokUsageConformanceCase,
  type XAiGrokUsageConformanceRequirements,
  type XAiGrokUsageConformanceSettings
} from './usage-cases.ts'
import { xAiGrokUsageSnapshotFixture } from './usage-snapshot.ts'

export {
  XAiGrokConformanceConfig,
  xAiGrokConformanceCases,
  xAiGrokConformanceDefaultModels,
  xAiGrokConformanceResponsesUrl,
  xAiGrokErrorEnvelopeCase,
  xAiGrokFunctionCallArgumentsCase,
  xAiGrokPlainTextCase,
  xAiGrokTerminalEventCase,
  type XAiGrokConformanceCase,
  type XAiGrokConformanceModels,
  type XAiGrokConformanceRequirements,
  type XAiGrokConformanceSettings,
  xAiGrokErrorEnvelopeFixture,
  xAiGrokFunctionCallArgumentsFixture,
  xAiGrokPlainTextFixture,
  xAiGrokTerminalEventFixture,
  XAiGrokUsageConformanceConfig,
  xAiGrokUsageConformanceCases,
  xAiGrokUsageConformanceUrl,
  xAiGrokUsageSnapshotCase,
  type XAiGrokUsageConformanceCase,
  type XAiGrokUsageConformanceRequirements,
  type XAiGrokUsageConformanceSettings,
  xAiGrokUsageSnapshotFixture
}

/** Every Grok Responses wire fixture, for replaying a whole conformance suite at once. */
export const xAiGrokConformanceFixtures: ReadonlyArray<WireFixture> = [
  xAiGrokPlainTextFixture,
  xAiGrokFunctionCallArgumentsFixture,
  xAiGrokErrorEnvelopeFixture,
  xAiGrokTerminalEventFixture
]

/** Every Grok subscription-usage wire fixture. */
export const xAiGrokUsageConformanceFixtures: ReadonlyArray<WireFixture> = [
  xAiGrokUsageSnapshotFixture
]
