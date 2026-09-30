import type { MicrosoftConformanceSeeds } from './cases.ts'

/**
 * Seed identities the committed Microsoft fixtures were recorded with. Replaying the fixtures needs
 * these exact seeds in `MicrosoftConformanceConfig`. `pnpm conformance:microsoft --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const microsoftConformanceFixtureSeeds: MicrosoftConformanceSeeds = {
  mailbox: 'ada@example.test',
  calendarId: 'AAMkAGI2-synthetic-calendar-0001=',
  calendarRangeStart: '2026-09-21T00:00:00Z',
  calendarRangeEnd: '2026-09-28T00:00:00Z',
  calendarEventId: 'AAMkAGI2-synthetic-event-0001=',
  calendarEventStart: '2026-09-23T12:00:00Z',
  attachmentMessageId: 'AAMkAGI2-synthetic-message-0001=',
  pagingFolderId: 'AAMkAGI2-synthetic-folder-0001=',
  driveId: 'b!synthetic-drive-0001',
  driveParentItemId: '01SYNTHETICPARENTFOLDER0000000001',
  copySourceItemId: '01SYNTHETICSOURCEFILE00000000001'
}
