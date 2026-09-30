/**
 * Vercel AI Gateway wire fixtures for replay with `@yolk-sdk/conformance/replay`.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * OpenAI-compatible Gateway Chat Completions wire; a live probe replaces them with verified
 * recordings.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { vercelAiGatewayDeepSeekReasoningFixture } from './deepseek-reasoning.ts'
import { vercelAiGatewayErrorEnvelopeFixture } from './error-envelope.ts'
import { vercelAiGatewayPlainTextFixture } from './plain-text.ts'
import { vercelAiGatewayToolCallDeltasFixture } from './tool-call-deltas.ts'

export {
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
