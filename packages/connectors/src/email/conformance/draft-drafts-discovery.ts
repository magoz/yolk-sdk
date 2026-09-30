import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  syntheticDeleted,
  syntheticDraftCompose,
  syntheticDraftMessage,
  syntheticImapConnection
} from './synthetic.ts'

const subject = 'yolk-conformance draft discovery: safe to delete'

/**
 * A folder-less draft saved into the discovered `\Drafts` mailbox (`Saved Drafts`), read back, and
 * permanently deleted. Synthetic placeholders (no `observed`).
 */
export const emailDraftsDiscoveryFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.imap.draft-drafts-discovery.create.synthetic',
    port: 'EmailClient',
    method: 'createDraft',
    request: { connection: syntheticImapConnection, message: syntheticDraftCompose(subject) },
    response: { saved: true, folder: 'Saved Drafts', draftId: '1700000002:7' },
    note: 'APPEND (\\Draft) to the mailbox LIST advertises as \\Drafts; UIDPLUS APPENDUID gives the id. Synthetic.'
  },
  {
    id: 'email.imap.draft-drafts-discovery.get.synthetic',
    port: 'EmailClient',
    method: 'getMessage',
    request: {
      connection: syntheticImapConnection,
      messageId: '1700000002:7',
      folder: 'Saved Drafts'
    },
    response: syntheticDraftMessage({
      id: '1700000002:7',
      subject,
      messageId: '<draft.0007@example.test>'
    }),
    note: 'The saved draft read back by its draftId. Synthetic.'
  },
  {
    id: 'email.imap.draft-drafts-discovery.delete.synthetic',
    port: 'EmailClient',
    method: 'deletePermanently',
    request: {
      connection: syntheticImapConnection,
      messageIds: ['1700000002:7'],
      folder: 'Saved Drafts'
    },
    response: syntheticDeleted('1700000002:7'),
    note: 'Restore: UID-scoped permanent delete of the case-created draft. Synthetic.'
  }
]
