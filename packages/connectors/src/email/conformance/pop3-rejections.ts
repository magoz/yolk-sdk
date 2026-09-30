import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { syntheticPop3Connection, syntheticPracticeAddress } from './synthetic.ts'

/**
 * The POP3 control: a plain maildrop list (UIDL ids, no flags). Every rejection in the case fails
 * before the port, so it has no fixture. Synthetic placeholder (no `observed`).
 */
export const emailPop3RejectionsFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.pop3.rejects-folders-drafts-mutations.list.synthetic',
    port: 'EmailClient',
    method: 'listMessages',
    request: { connection: syntheticPop3Connection, limit: 50 },
    response: {
      messages: [
        {
          id: 'uidl-synthetic-0041',
          subject: 'Synthetic welcome',
          from: [{ address: 'sender@example.test', name: 'Synthetic Sender' }],
          to: [{ address: syntheticPracticeAddress }],
          sentAt: '2026-09-28T08:00:00.000Z',
          hasAttachments: false
        },
        {
          id: 'uidl-synthetic-0042',
          subject: 'Synthetic weekly summary',
          from: [{ address: 'sender@example.test', name: 'Synthetic Sender' }],
          to: [{ address: syntheticPracticeAddress }],
          sentAt: '2026-09-29T08:00:00.000Z',
          hasAttachments: false
        }
      ]
    },
    note: 'POP3 maildrop list (UIDL plus TOP headers); POP3 has no read or flagged state. Synthetic.'
  }
]
