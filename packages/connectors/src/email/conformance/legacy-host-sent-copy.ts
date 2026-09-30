import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { syntheticPracticeAddress, syntheticSmtpConnection } from './synthetic.ts'

const send = (id: string, subject: string, submissionId: string) =>
  ({
    id: `email.smtp.legacy-host-sent-copy.${id}.synthetic`,
    port: 'EmailClient',
    method: 'sendMessage',
    request: {
      connection: syntheticSmtpConnection,
      message: {
        to: [{ address: syntheticPracticeAddress }],
        subject,
        body: { text: 'Synthetic legacy-host conformance message.' }
      }
    },
    response: { accepted: true, submissionId },
    note: 'What the host sees behind the legacy shim: no sentCopy in, none out. Synthetic.'
  }) satisfies PortFixture

/** Two submissions behind the legacy-host shim. Synthetic placeholders (no `observed`). */
export const emailLegacySentCopyFixtures: ReadonlyArray<PortFixture> = [
  send(
    'send-requested',
    'yolk-conformance send: legacy host, copy requested',
    'synthetic-submission-0004'
  ),
  send(
    'send-disabled',
    'yolk-conformance send: legacy host, copy disabled',
    'synthetic-submission-0005'
  )
]
