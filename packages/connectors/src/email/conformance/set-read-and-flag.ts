import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { syntheticImapConnection, syntheticWelcomeMessage } from './synthetic.ts'

const messageId = '1700000001:41'

const get = (id: string, flags: { readonly isRead: boolean; readonly isFlagged: boolean }) =>
  ({
    id: `email.imap.set-read-and-flag.${id}.synthetic`,
    port: 'EmailClient',
    method: 'getMessage',
    request: { connection: syntheticImapConnection, messageId },
    response: syntheticWelcomeMessage(flags),
    note: `Get of the seeded message (read ${flags.isRead}, flagged ${flags.isFlagged}). Synthetic.`
  }) satisfies PortFixture

const setRead = (id: string, isRead: boolean) =>
  ({
    id: `email.imap.set-read-and-flag.${id}.synthetic`,
    port: 'EmailClient',
    method: 'setRead',
    request: { connection: syntheticImapConnection, messageId, folder: 'INBOX', isRead },
    response: { messageId, isRead },
    note: `UID STORE ${isRead ? '+' : '-'}FLAGS.SILENT (\\Seen). Synthetic.`
  }) satisfies PortFixture

const setFlag = (id: string, isFlagged: boolean) =>
  ({
    id: `email.imap.set-read-and-flag.${id}.synthetic`,
    port: 'EmailClient',
    method: 'setFlag',
    request: { connection: syntheticImapConnection, messageId, folder: 'INBOX', isFlagged },
    response: { messageId, isFlagged },
    note: `UID STORE ${isFlagged ? '+' : '-'}FLAGS.SILENT (\\Flagged). Synthetic.`
  }) satisfies PortFixture

/**
 * Read and flag the seeded message, reading it back after each change, then restore both flags.
 * Synthetic placeholders (no `observed`).
 */
export const emailSetReadAndFlagFixtures: ReadonlyArray<PortFixture> = [
  get('get-before', { isRead: false, isFlagged: false }),
  setRead('set-read', true),
  get('get-read', { isRead: true, isFlagged: false }),
  setFlag('set-flag', true),
  get('get-flagged', { isRead: true, isFlagged: true }),
  setRead('restore-read', false),
  setFlag('restore-flag', false),
  get('get-restored', { isRead: false, isFlagged: false })
]
