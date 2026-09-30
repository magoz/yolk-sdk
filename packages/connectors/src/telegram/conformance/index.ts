/**
 * Telegram conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions, or the host-only `downloadTelegramFile` helper, over
 * the connector ports. The current fixtures are synthetic placeholders (`evidence: 'unverified'`)
 * shaped like the Telegram Bot API wire; their URLs carry the synthetic
 * `telegramConformanceReplayBotToken`. `pnpm conformance:telegram --live --owner-approved --account
 * <label> --record` stages verified recordings from a practice bot in a gitignored directory (with
 * the live bot token replaced by the replay token); a person scrubs them and promotes them here,
 * updating the tests together with them (fixture ids, `evidence`, and `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { telegramErrorEnvelopeFixture } from './error-envelope.ts'
import { telegramGetFilePathFixture } from './get-file-path.ts'
import { telegramSendMessageFixture } from './send-message.ts'
import { telegramValidateGetChatFixture } from './validate-get-chat.ts'

export {
  TelegramConformanceActionFailed,
  TelegramConformanceConfig,
  TelegramConformanceSeeds,
  telegramConformanceCases,
  telegramConformanceCredentialRef,
  telegramConformanceIntegration,
  telegramConformanceMarker,
  telegramConformanceReplayBotToken,
  telegramErrorEnvelopeCase,
  telegramGetFilePathCase,
  telegramSendMessageCase,
  telegramValidateGetChatCase,
  type TelegramConformanceCase,
  type TelegramConformanceError,
  type TelegramConformanceRequirements,
  type TelegramConformanceSeedKey
} from './cases.ts'

export { telegramConformanceFixtureSeeds } from './seeds.ts'

export {
  telegramErrorEnvelopeFixture,
  telegramGetFilePathFixture,
  telegramSendMessageFixture,
  telegramValidateGetChatFixture
}

/** Every Telegram wire fixture, in case order, for replaying the whole suite at once. */
export const telegramConformanceFixtures: ReadonlyArray<WireFixture> = [
  telegramValidateGetChatFixture,
  telegramErrorEnvelopeFixture,
  telegramGetFilePathFixture,
  telegramSendMessageFixture
]
