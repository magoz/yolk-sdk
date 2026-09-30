/**
 * OpenCode Go wire fixtures for replay with `@yolk-sdk/conformance/replay`, and the conformance
 * cases they back for `@yolk-sdk/conformance/runner`: streamed plain text on each Go protocol
 * (`chat-completions`, `messages`, `responses`), the Responses commentary-phase replay, and the Go
 * subscription-usage snapshot.
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like each
 * wire; a live probe (`pnpm conformance:opencode`, `OPENCODE_API_KEY`, owner approval required)
 * replaces them with verified recordings.
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { openCodeGoChatPlainTextFixture } from './chat-plain-text.ts'
import {
  OpenCodeGoConformanceConfig,
  openCodeGoChatPlainTextCase,
  openCodeGoConformanceBaseUrl,
  openCodeGoConformanceCases,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceUsageUrl,
  openCodeGoMessagesPlainTextCase,
  openCodeGoResponsesCommentaryReplayCase,
  openCodeGoResponsesPlainTextCase,
  openCodeGoUsageSnapshotCase,
  type OpenCodeGoConformanceCase,
  type OpenCodeGoConformanceModels,
  type OpenCodeGoConformanceRequirements,
  type OpenCodeGoConformanceSettings
} from './cases.ts'
import { openCodeGoMessagesPlainTextFixture } from './messages-plain-text.ts'
import { openCodeGoResponsesCommentaryReplayFixture } from './responses-commentary-replay.ts'
import { openCodeGoResponsesPlainTextFixture } from './responses-plain-text.ts'
import { openCodeGoUsageSnapshotFixture } from './usage-snapshot.ts'

export {
  OpenCodeGoConformanceConfig,
  openCodeGoChatPlainTextCase,
  openCodeGoConformanceBaseUrl,
  openCodeGoConformanceCases,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceUsageUrl,
  openCodeGoMessagesPlainTextCase,
  openCodeGoResponsesCommentaryReplayCase,
  openCodeGoResponsesPlainTextCase,
  openCodeGoUsageSnapshotCase,
  type OpenCodeGoConformanceCase,
  type OpenCodeGoConformanceModels,
  type OpenCodeGoConformanceRequirements,
  type OpenCodeGoConformanceSettings,
  openCodeGoChatPlainTextFixture,
  openCodeGoMessagesPlainTextFixture,
  openCodeGoResponsesCommentaryReplayFixture,
  openCodeGoResponsesPlainTextFixture,
  openCodeGoUsageSnapshotFixture
}

/** Every OpenCode Go wire fixture, for replaying the whole Go conformance suite at once. */
export const openCodeGoConformanceFixtures: ReadonlyArray<WireFixture> = [
  openCodeGoChatPlainTextFixture,
  openCodeGoMessagesPlainTextFixture,
  openCodeGoResponsesPlainTextFixture,
  openCodeGoResponsesCommentaryReplayFixture,
  openCodeGoUsageSnapshotFixture
]
