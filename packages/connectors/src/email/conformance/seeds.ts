import type { EmailConformanceSeeds } from './cases.ts'

/**
 * Seeds of the synthetic practice mailbox the committed email fixtures describe. Replaying the
 * fixtures needs these exact seeds in `EmailConformanceConfig`; a live run supplies the practice
 * mailbox's own values.
 */
export const emailConformanceFixtureSeeds: EmailConformanceSeeds = {
  imapHost: 'imap.example.test',
  pop3Host: 'pop3.example.test',
  smtpHost: 'smtp.example.test',
  unreadMessageId: '1700000001:41',
  draftsFolder: 'Saved Drafts',
  sentFolder: 'Sent Items',
  trashFolder: 'Deleted Items',
  moveDestinationFolder: 'Archive',
  recipient: 'practice@example.test',
  undeliverableRecipient: 'nobody@undeliverable.example.test'
}
