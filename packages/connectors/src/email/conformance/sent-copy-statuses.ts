import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  syntheticImapConnection,
  syntheticPracticeAddress,
  syntheticSmtpConnection
} from './synthetic.ts'

const message = (subject: string) => ({
  to: [{ address: syntheticPracticeAddress }],
  subject,
  body: { text: 'Synthetic conformance message to the practice mailbox.' }
})

/**
 * Three submissions to the practice mailbox: a saved Sent copy, a disabled copy (the host reports
 * none; the action synthesizes `skipped`), and a copy into a missing mailbox (`failed`, still
 * accepted). Synthetic placeholders (no `observed`).
 */
export const emailSentCopyStatusesFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.smtp.sent-copy-statuses.send-saved.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: syntheticSmtpConnection,
      message: message('yolk-conformance send: saved copy'),
      sentCopy: { connection: syntheticImapConnection }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0001',
      sentCopy: { status: 'saved', folder: 'Sent Items' }
    },
    note: 'SMTP 250 after DATA, then APPEND of the same bytes to the mailbox LIST advertises as \\Sent. Synthetic.'
  },
  {
    id: 'email.smtp.sent-copy-statuses.send-skipped.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: syntheticSmtpConnection,
      message: message('yolk-conformance send: copy skipped')
    },
    response: { accepted: true, submissionId: 'synthetic-submission-0002' },
    note: 'No sentCopy requested, none reported; the action synthesizes skipped. Synthetic.'
  },
  {
    id: 'email.smtp.sent-copy-statuses.send-failed.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: syntheticSmtpConnection,
      message: message('yolk-conformance send: copy fails'),
      sentCopy: {
        connection: syntheticImapConnection,
        folder: 'yolk-conformance-missing-sent-folder'
      }
    },
    response: {
      accepted: true,
      submissionId: 'synthetic-submission-0003',
      sentCopy: { status: 'failed', folder: 'yolk-conformance-missing-sent-folder' }
    },
    note: 'SMTP accepted; APPEND answered NO [TRYCREATE], so the copy failed (never resend). Synthetic.'
  }
]
