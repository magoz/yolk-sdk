/**
 * Vercel AI Gateway wire fixtures for replay with `@yolk-sdk/conformance/replay`, and the
 * conformance cases they back for `@yolk-sdk/conformance/runner`.
 *
 * The fixtures are verified live recordings (`evidence: 'verified'`, recorded 2026-09-30 with the
 * synthetic account label `synthetic` and synthetic prompts) of the OpenAI-compatible Gateway Chat
 * Completions wire, written by `pnpm conformance:gateway --live --owner-approved --account <label>`.
 * The DeepSeek fixture was recorded with `deepseek/deepseek-v4.1-flash`, now the default reasoning
 * model, so `vercelAiGatewayConformanceDefaultModels` names the model of every committed fixture.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  VercelAiGatewayConformanceConfig,
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceDefaultModels,
  vercelAiGatewayDeepSeekReasoningCase,
  vercelAiGatewayErrorEnvelopeCase,
  vercelAiGatewayPlainTextCase,
  vercelAiGatewayToolCallDeltasCase,
  type VercelAiGatewayConformanceCase,
  type VercelAiGatewayConformanceModels,
  type VercelAiGatewayConformanceRequirements,
  type VercelAiGatewayConformanceSettings
} from './cases.ts'
import { vercelAiGatewayDeepSeekReasoningFixture } from './deepseek-reasoning.ts'
import { vercelAiGatewayErrorEnvelopeFixture } from './error-envelope.ts'
import { vercelAiGatewayPlainTextFixture } from './plain-text.ts'
import { vercelAiGatewayToolCallDeltasFixture } from './tool-call-deltas.ts'

export {
  VercelAiGatewayConformanceConfig,
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceDefaultModels,
  vercelAiGatewayDeepSeekReasoningCase,
  vercelAiGatewayErrorEnvelopeCase,
  vercelAiGatewayPlainTextCase,
  vercelAiGatewayToolCallDeltasCase,
  type VercelAiGatewayConformanceCase,
  type VercelAiGatewayConformanceModels,
  type VercelAiGatewayConformanceRequirements,
  type VercelAiGatewayConformanceSettings,
  vercelAiGatewayDeepSeekReasoningFixture,
  vercelAiGatewayErrorEnvelopeFixture,
  vercelAiGatewayPlainTextFixture,
  vercelAiGatewayToolCallDeltasFixture
}

/** Every Vercel AI Gateway wire fixture, for replaying a whole conformance suite at once. */
export const vercelAiGatewayConformanceFixtures: ReadonlyArray<WireFixture> = [
  vercelAiGatewayPlainTextFixture,
  vercelAiGatewayDeepSeekReasoningFixture,
  vercelAiGatewayToolCallDeltasFixture,
  vercelAiGatewayErrorEnvelopeFixture
]
