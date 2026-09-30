import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  syntheticDeleted,
  syntheticDraftCompose,
  syntheticDraftMessage,
  syntheticImapConnection
} from './synthetic.ts'

const subject = 'yolk-conformance move probe: safe to delete'

/**
 * A case-created draft moved to `Archive`: the move answers the destination UIDVALIDITY:UID, the
 * new id resolves there, the stale source id no longer resolves, and the message is permanently
 * deleted. Synthetic placeholders (no `observed`).
 */
export const emailMoveDestinationIdsFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.imap.move-destination-ids.create.synthetic',
    port: 'EmailClient',
    method: 'createDraft',
    request: {
      connection: syntheticImapConnection,
      message: syntheticDraftCompose(subject),
      folder: 'Saved Drafts'
    },
    response: { saved: true, folder: 'Saved Drafts', draftId: '1700000002:9' },
    note: 'The case-owned draft in the seeded Drafts mailbox. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.move.synthetic',
    port: 'EmailClient',
    method: 'move',
    request: {
      connection: syntheticImapConnection,
      messageId: '1700000002:9',
      folder: 'Saved Drafts',
      destinationFolder: 'Archive'
    },
    response: { moved: true, folder: 'Archive', messageId: '1700000005:12' },
    note: 'UID MOVE (RFC 6851); COPYUID gives the destination UIDVALIDITY:UID. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.get-destination.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: syntheticImapConnection,
      messageId: '1700000005:12',
      folder: 'Archive'
    },
    response: syntheticDraftMessage({
      id: '1700000005:12',
      subject,
      messageId: '<draft.0009@example.test>'
    }),
    note: 'The moved message read back by its destination id. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.get-stale-source.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: syntheticImapConnection,
      messageId: '1700000002:9',
      folder: 'Saved Drafts'
    },
    failure: {
      kind: 'expected',
      code: 'message_not_found',
      message: 'No message with that UID in the mailbox.'
    },
    note: 'The stale source id no longer resolves after the move. Synthetic.'
  },
  {
    id: 'email.imap.move-destination-ids.delete.synthetic',
    port: 'EmailClient',
    method: 'deletePermanently',
    request: {
      connection: syntheticImapConnection,
      messageIds: ['1700000005:12'],
      folder: 'Archive'
    },
    response: syntheticDeleted('1700000005:12'),
    note: 'Restore: UID-scoped permanent delete in the destination. Synthetic.'
  }
]
