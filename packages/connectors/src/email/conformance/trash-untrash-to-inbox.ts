import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  syntheticDeleted,
  syntheticDraftCompose,
  syntheticDraftMessage,
  syntheticImapConnection
} from './synthetic.ts'

const subject = 'yolk-conformance trash probe: safe to delete'

/**
 * A case-created draft trashed into the discovered `\Trash` mailbox (`Deleted Items`), restored to
 * INBOX (not `Saved Drafts`), read back there, and permanently deleted. Each move answers the
 * destination UIDVALIDITY:UID. Synthetic placeholders (no `observed`).
 */
export const emailTrashUntrashFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.imap.trash-untrash-to-inbox.create.synthetic',
    port: 'EmailClient',
    method: 'createDraft',
    request: {
      connection: syntheticImapConnection,
      message: syntheticDraftCompose(subject),
      folder: 'Saved Drafts'
    },
    response: { saved: true, folder: 'Saved Drafts', draftId: '1700000002:8' },
    note: 'The case-owned draft in the seeded Drafts mailbox. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.trash.synthetic',
    port: 'EmailClient',
    method: 'trash',
    request: {
      connection: syntheticImapConnection,
      messageId: '1700000002:8',
      folder: 'Saved Drafts'
    },
    response: { moved: true, folder: 'Deleted Items', messageId: '1700000004:3' },
    note: 'UID MOVE to the mailbox LIST advertises as \\Trash; COPYUID gives the destination id. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.untrash.synthetic',
    port: 'EmailClient',
    method: 'untrash',
    request: {
      connection: syntheticImapConnection,
      messageId: '1700000004:3',
      folder: 'Deleted Items',
      destinationFolder: 'INBOX'
    },
    response: { moved: true, folder: 'INBOX', messageId: '1700000001:43' },
    note: 'Restore defaults to INBOX, not the original Drafts mailbox. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.get.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: { connection: syntheticImapConnection, messageId: '1700000001:43' },
    response: syntheticDraftMessage({
      id: '1700000001:43',
      subject,
      messageId: '<draft.0008@example.test>'
    }),
    note: 'The restored message read back in INBOX by its new id. Synthetic.'
  },
  {
    id: 'email.imap.trash-untrash-to-inbox.delete.synthetic',
    port: 'EmailClient',
    method: 'deletePermanently',
    request: {
      connection: syntheticImapConnection,
      messageIds: ['1700000001:43'],
      folder: 'INBOX'
    },
    response: syntheticDeleted('1700000001:43'),
    note: 'Restore: UID-scoped permanent delete where the message ended up. Synthetic.'
  }
]
