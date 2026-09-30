import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  syntheticImapConnection,
  syntheticWeeklySummary,
  syntheticWelcomeMessage,
  syntheticWelcomeSummary
} from './synthetic.ts'

const inboxList = (id: string, note: string): PortFixture => ({
  id,
  port: 'EmailClient',
  method: 'listMessages',
  request: { connection: syntheticImapConnection, limit: 50 },
  response: { messages: [syntheticWelcomeSummary, syntheticWeeklySummary] },
  note
})

/**
 * INBOX list, get of the seeded unread message (with its RFC 5322 headers), and the same list
 * again (the message stays unread). Synthetic placeholders (no `observed`) until a live run
 * against a practice mailbox through a host `EmailClient` replaces them.
 */
export const emailListAndGetHeadersFixtures: ReadonlyArray<PortFixture> = [
  inboxList(
    'email.imap.list-and-get-headers.list.synthetic',
    'Unfiltered INBOX list: the seeded unread message and one read message. Synthetic.'
  ),
  {
    id: 'email.imap.list-and-get-headers.get.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: { connection: syntheticImapConnection, messageId: '1700000001:41' },
    response: syntheticWelcomeMessage({ isRead: false, isFlagged: false }),
    note: 'Get of the seeded unread message with its header fields (BODY.PEEK[HEADER]). Synthetic.'
  },
  inboxList(
    'email.imap.list-and-get-headers.list-again.synthetic',
    'The same INBOX list after the get: the message is still unread. Synthetic.'
  )
]
