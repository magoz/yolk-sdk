/**
 * Shared synthetic shapes of the email fixtures (internal): the practice-mailbox connections and
 * the seeded messages as a host `EmailClient` would answer them. Synthetic data only
 * (`example.test` hosts and addresses); never recorded from a live mailbox.
 */
import type * as Schema from 'effect/Schema'

export const syntheticImapConnection = {
  protocol: 'imap',
  host: 'imap.example.test',
  port: 993,
  security: 'tls'
} satisfies Schema.Json

export const syntheticPop3Connection = {
  protocol: 'pop3',
  host: 'pop3.example.test',
  port: 995,
  security: 'tls'
} satisfies Schema.Json

export const syntheticSmtpConnection = {
  protocol: 'smtp',
  host: 'smtp.example.test',
  port: 587,
  security: 'starttls'
} satisfies Schema.Json

export const syntheticPracticeAddress = 'practice@example.test'

const welcomeFrom = [{ address: 'sender@example.test', name: 'Synthetic Sender' }]

const practiceTo = [{ address: syntheticPracticeAddress }]

/** Summary of the seeded unread, unflagged INBOX message. */
export const syntheticWelcomeSummary = {
  id: '1700000001:41',
  subject: 'Synthetic welcome',
  from: welcomeFrom,
  to: practiceTo,
  sentAt: '2026-09-28T08:00:00.000Z',
  receivedAt: '2026-09-28T08:00:05.000Z',
  snippet: 'Welcome to the synthetic practice mailbox.',
  hasAttachments: false,
  isRead: false,
  isFlagged: false
} satisfies Schema.Json

/** Summary of the second seeded INBOX message (already read). */
export const syntheticWeeklySummary = {
  id: '1700000001:42',
  subject: 'Synthetic weekly summary',
  from: welcomeFrom,
  to: practiceTo,
  sentAt: '2026-09-29T08:00:00.000Z',
  receivedAt: '2026-09-29T08:00:04.000Z',
  snippet: 'Nothing happened this synthetic week.',
  hasAttachments: false,
  isRead: true,
  isFlagged: false
} satisfies Schema.Json

/** The seeded unread message as `getMessage` answers it, with the given flags. */
export const syntheticWelcomeMessage = (flags: {
  readonly isRead: boolean
  readonly isFlagged: boolean
}): Schema.Json => ({
  message: {
    id: '1700000001:41',
    messageId: '<welcome.0001@example.test>',
    subject: 'Synthetic welcome',
    from: welcomeFrom,
    to: practiceTo,
    cc: [],
    bcc: [],
    replyTo: [],
    sentAt: '2026-09-28T08:00:00.000Z',
    receivedAt: '2026-09-28T08:00:05.000Z',
    body: { text: 'Welcome to the synthetic practice mailbox.' },
    attachments: [],
    isRead: flags.isRead,
    isFlagged: flags.isFlagged,
    headers: [
      { name: 'Date', value: 'Mon, 28 Sep 2026 08:00:00 +0000' },
      { name: 'From', value: 'Synthetic Sender <sender@example.test>' },
      { name: 'To', value: syntheticPracticeAddress },
      { name: 'Subject', value: 'Synthetic welcome' },
      { name: 'Message-ID', value: '<welcome.0001@example.test>' }
    ]
  }
})

/** A case-created draft as `getMessage` answers it (drafts are appended `\Draft \Seen`). */
export const syntheticDraftMessage = (input: {
  readonly id: string
  readonly subject: string
  readonly messageId: string
}): Schema.Json => ({
  message: {
    id: input.id,
    messageId: input.messageId,
    subject: input.subject,
    from: practiceTo,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    sentAt: '2026-09-30T09:00:00.000Z',
    body: { text: 'Synthetic conformance draft; never sent.' },
    attachments: [],
    isRead: true,
    isFlagged: false,
    headers: [
      { name: 'Date', value: 'Wed, 30 Sep 2026 09:00:00 +0000' },
      { name: 'From', value: syntheticPracticeAddress },
      { name: 'Subject', value: input.subject },
      { name: 'Message-ID', value: input.messageId }
    ]
  }
})

/** A draft request body as the connector sends it (no recipients, text body). */
export const syntheticDraftCompose = (subject: string): Schema.Json => ({
  to: [],
  subject,
  body: { text: 'Synthetic conformance draft; never sent.' }
})

/** One succeeded `deletePermanently` result for a single id. */
export const syntheticDeleted = (messageId: string): Schema.Json => ({
  results: [{ messageId, status: 'succeeded' }],
  summary: { requested: 1, succeeded: 1, failed: 0, unknown: 0, notAttempted: 0 }
})
