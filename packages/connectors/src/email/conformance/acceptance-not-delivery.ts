import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { syntheticSmtpConnection } from './synthetic.ts'

/**
 * A submission to an undeliverable address that SMTP still accepts. Synthetic placeholder (no
 * `observed`).
 */
export const emailAcceptanceNotDeliveryFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'email.smtp.acceptance-not-delivery.send.synthetic',
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: syntheticSmtpConnection,
      message: {
        to: [{ address: 'nobody@undeliverable.example.test' }],
        subject: 'yolk-conformance send: accepted, undeliverable',
        body: { text: 'Synthetic conformance message to an undeliverable address.' }
      }
    },
    response: { accepted: true, submissionId: 'synthetic-submission-0006' },
    note: 'SMTP 250 for the submission; the bounce (DSN) would arrive later. Synthetic.'
  }
]
