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
  copySourceItemId: '01SYNTHETICSOURCEFILE00000000001',
  siteSearchQuery: 'synthetic',
  siteId:
    'synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
  chatId: '19:synthetic-chat-0001@thread.v2',
  sendChatId: '19:synthetic-send-chat-0001@thread.v2',
  teamId: '00000000-0000-4000-8000-000000007ea1',
  channelId: '19:synthetic-channel-0001@thread.tacv2',
  channelMessageId: '1789900000101',
  meetingJoinWebUrl:
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_c3ludGhldGljLW1lZXRpbmctMDAwMQ%40thread.v2/0?context=%7b%22Tid%22%3a%2200000000-0000-4000-8000-00000000c0de%22%2c%22Oid%22%3a%2200000000-0000-4000-8000-00000000ada1%22%7d',
  runId: 'run-synthetic'
}
