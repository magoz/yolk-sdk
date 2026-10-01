import {
  GoogleConformanceRunId,
  GooglePracticeAddress,
  type GoogleConformanceSeeds
} from './cases.ts'

/**
 * Seed values used by the committed Google fixtures (synthetic until a scrubbed recording is
 * promoted). Replaying the fixtures needs these exact seeds in `GoogleConformanceConfig`.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const googleConformanceFixtureSeeds: GoogleConformanceSeeds = {
  practiceAddress: GooglePracticeAddress.make('practice@example.test'),
  pagingLabelId: 'Label_9001',
  attachmentMessageId: '18f00000000000a1',
  workMessageId: '18f00000000000b1',
  calendarId: 'practice-calendar@example.test',
  eventRangeStart: '2026-09-01T00:00:00Z',
  eventRangeEnd: '2026-09-08T00:00:00Z',
  driveFolderId: 'synthetic-practice-folder-0001',
  driveFileId: 'synthetic-practice-file-0001',
  runId: GoogleConformanceRunId.make('run-synthetic')
}
