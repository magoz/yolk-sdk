import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { syntheticImapConnection, syntheticWelcomeSummary } from './synthetic.ts'

/**
 * `listMessagesFiltered` with `isRead: false` answers only unread messages. Synthetic placeholder
 * (no `observed`); the legacy-host half of the case never reaches the port.
 */
export const emailFilteredListNoFallbackFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.imap.filtered-list-no-fallback.list-unread.synthetic',
    port: 'EmailClient',
    method: 'listMessagesFiltered',
    request: { connection: syntheticImapConnection, limit: 50, isRead: false },
    response: { messages: [syntheticWelcomeSummary] },
    note: 'Filtered INBOX list (UID SEARCH UNSEEN): only the seeded unread message. Synthetic.'
  }
]
