import type { TelegramConformanceSeeds } from './cases.ts'

/**
 * Seed ids used by the committed Telegram fixtures (synthetic until a scrubbed recording is
 * promoted). Replaying the fixtures needs these exact seeds in `TelegramConformanceConfig`.
 * `pnpm conformance:telegram --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const telegramConformanceFixtureSeeds: TelegramConformanceSeeds = {
  chatId: '-1001000000001',
  fileId: 'BQACAgIAAxkDAAIC-yolk_synthetic_file_0001',
  runId: 'run-synthetic'
}
