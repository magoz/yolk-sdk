import { describe, expect, it } from 'vitest'
import type * as Schema from 'effect/Schema'
import { isPortCredentialKey } from '@yolk-sdk/conformance/fixture'
import {
  EmailEmulatorInputInvalid,
  emailEmulatorDefaultSeed,
  emailEmulatorFixtures,
  emailEmulatorRoutes,
  makeEmailEmulator,
  type EmailEmulatorFault,
  type EmailEmulatorFixture,
  type EmailEmulatorSeed
} from '../src/email.ts'

const imap = { protocol: 'imap', host: 'imap.example.test', port: 993, security: 'tls' }

const fixture = (id: string): EmailEmulatorFixture => {
  const found = emailEmulatorFixtures.find(candidate => candidate.id === id)

  if (found === undefined) {
    return expect.fail(`missing fixture ${id}`)
  }

  return found
}

const listFixture = fixture('email.imap.list-and-get-headers.list.synthetic')

const getFixture = fixture('email.imap.list-and-get-headers.get.synthetic')

const synthetic = (id: string) => `email.imap.${id}.synthetic`

const call = (emulator: ReturnType<typeof makeEmailEmulator>, id: string) => {
  const recorded = fixture(id)

  return emulator.call(recorded.method, recorded.request)
}

const failure = { kind: 'expected', code: 'synthetic_fault', message: 'Synthetic fault.' } as const

/** Runtime-only input for validation tests: a JSON copy typed as whatever the API expects. */
const untyped = <T>(value: unknown): T => JSON.parse(JSON.stringify(value))

describe('email emulator: answers only from fixtures', () => {
  it('answers a recorded request with the recorded response and ledgers it', () => {
    const emulator = makeEmailEmulator()

    expect(emulator.call('listMessages', listFixture.request)).toEqual({
      response: listFixture.response
    })
    expect(emulator.ledger.entries()).toEqual([
      {
        seq: 1,
        method: 'listMessages',
        request: listFixture.request,
        outcome: 'answered',
        evidence: 'unverified',
        fixtureId: listFixture.id
      }
    ])
  })

  it('answers failure fixtures as failures', () => {
    const emulator = makeEmailEmulator()
    const stale = fixture('email.imap.move-destination-ids.get-stale-source.synthetic')

    expect(emulator.call(stale.method, stale.request)).toEqual({ failure: stale.failure })
  })

  it('allows only the documented request-shape latitude: credentials and connection.host', () => {
    const emulator = makeEmailEmulator()

    const reply = emulator.call('listMessages', {
      connection: { ...imap, host: 'other.example.test' },
      credential: { username: 'practice@example.test', password: 'synthetic-secret-value' },
      limit: 50
    })

    expect(reply).toEqual({ response: listFixture.response })

    const ledgered = JSON.stringify(emulator.ledger.entries())

    expect(ledgered).not.toContain('synthetic-secret-value')
    expect(ledgered).not.toContain('credential')
    // The ledger keeps the request as received (host included), minus credentials.
    expect(emulator.ledger.entries()[0]?.request).toEqual({
      connection: { ...imap, host: 'other.example.test' },
      limit: 50
    })

    // Every other connection field is compared: a different port or security fails closed.
    for (const connection of [
      { ...imap, port: 143 },
      { ...imap, security: 'starttls' },
      { protocol: 'imap', host: 'imap.example.test' }
    ]) {
      expect(
        emulator.call('listMessages', { connection, limit: 50 }),
        JSON.stringify(connection)
      ).toEqual({
        notEmulated: { reason: 'no-matching-fixture: no fixture matches this request' }
      })
    }
  })

  it('drops exactly the credential keys @yolk-sdk/conformance classifies as credentials', () => {
    const keys = [
      'credential',
      'Credentials',
      'password',
      'passwd',
      'api_key',
      'apiKey',
      'accessToken',
      'refresh_token',
      'token',
      'secret',
      'client_secret',
      'authorization',
      'max_tokens',
      'credentialRef',
      'username',
      'tokens',
      'folder'
    ]

    for (const key of keys) {
      const emulator = makeEmailEmulator()

      emulator.call('listMessages', { connection: imap, limit: 50, [key]: 'synthetic-value' })

      const ledgered = JSON.stringify(emulator.ledger.entries()[0]?.request ?? null)

      expect(ledgered.includes(`"${key}":`), key).toBe(!isPortCredentialKey(key))
    }
  })
})

describe('email emulator: fails closed', () => {
  it('refuses an unknown method with a ledgered not-emulated answer', () => {
    const emulator = makeEmailEmulator()

    expect(emulator.call('modifyLabels', { connection: imap })).toEqual({
      notEmulated: { reason: 'unknown-method: the method has no emulated route' }
    })
    expect(emulator.ledger.entries()[0]).toMatchObject({
      method: 'modifyLabels',
      outcome: 'not-emulated',
      evidence: 'unknown-method',
      reason: 'unknown-method'
    })
  })

  it('refuses a request that is not a JSON object', () => {
    const emulator = makeEmailEmulator()

    expect(emulator.call('listMessages', ['not', 'an', 'object'])).toEqual({
      notEmulated: { reason: 'invalid-request: the request is not a JSON object' }
    })
  })

  it('refuses requests that differ from every fixture beyond the latitude', () => {
    const emulator = makeEmailEmulator()

    const variants: ReadonlyArray<Schema.Json> = [
      { connection: imap, limit: 10 },
      { connection: { ...imap, protocol: 'pop3' }, limit: 10 },
      { connection: imap, limit: 50, folder: 'Archive' },
      { connection: imap, limit: 50, cursor: 'next' },
      { limit: 50 }
    ]

    for (const request of variants) {
      expect(emulator.call('listMessages', request)).toEqual({
        notEmulated: { reason: 'no-matching-fixture: no fixture matches this request' }
      })
    }

    expect(emulator.ledger.entries().map(entry => entry.reason)).toEqual(
      variants.map(() => 'no-matching-fixture')
    )
    expect(emulator.coverage().notEmulatedCalls).toBe(variants.length)
  })

  it('refuses a matching fixture that contradicts the mailbox (state-conflict)', () => {
    const emulator = makeEmailEmulator()

    // The draft was never created, so it cannot be trashed.
    expect(call(emulator, synthetic('trash-untrash-to-inbox.trash'))).toEqual({
      notEmulated: {
        reason: 'state-conflict: no matching fixture is consistent with the emulated mailbox'
      }
    })
    // The stale-source failure is consistent only while the message is absent; after the draft
    // exists in Saved Drafts under that id, the same request no longer matches the mailbox.
    expect(call(emulator, synthetic('move-destination-ids.create'))).toHaveProperty('response')
    expect(call(emulator, synthetic('move-destination-ids.get-stale-source'))).toHaveProperty(
      'notEmulated'
    )
    expect(emulator.state()).toEqual(
      withMessage(emailEmulatorDefaultSeed, 'Saved Drafts', {
        id: '1700000002:9',
        subject: 'yolk-conformance move probe: safe to delete'
      })
    )
  })

  it('refuses a list whose recorded answer no longer matches the mailbox', () => {
    const emulator = makeEmailEmulator()

    expect(call(emulator, synthetic('set-read-and-flag.set-read'))).toHaveProperty('response')
    // The recorded INBOX list reports the message unread; the mailbox now says read.
    expect(emulator.call('listMessages', listFixture.request)).toHaveProperty('notEmulated')
  })
})

const withMessage = (
  seed: EmailEmulatorSeed,
  folderName: string,
  message: EmailEmulatorSeed['folders'][number]['messages'][number]
): EmailEmulatorSeed => ({
  folders: seed.folders.map(folder =>
    folder.name === folderName ? { ...folder, messages: [...folder.messages, message] } : folder
  )
})

describe('email emulator: mailbox state', () => {
  it('selects fixtures by state and records what they say happened', () => {
    const emulator = makeEmailEmulator()

    expect(emulator.call('getMessage', getFixture.request)).toEqual({
      response: getFixture.response
    })
    expect(call(emulator, synthetic('set-read-and-flag.set-read'))).toEqual({
      response: { messageId: '1700000001:41', isRead: true }
    })

    // The same get request is now answered by the fixture that reports the message read.
    expect(emulator.call('getMessage', getFixture.request)).toEqual({
      response: fixture(synthetic('set-read-and-flag.get-read')).response
    })
    expect(
      emulator.state().folders[0]?.messages.find(message => message.id === '1700000001:41')
    ).toMatchObject({ isRead: true, isFlagged: false })
  })

  it('moves messages to the destination ids the fixtures name, never invented ones', () => {
    const emulator = makeEmailEmulator()

    for (const step of ['create', 'trash', 'untrash']) {
      expect(call(emulator, synthetic(`trash-untrash-to-inbox.${step}`)), step).toHaveProperty(
        'response'
      )
    }

    expect(emulator.state()).toEqual(
      withMessage(emailEmulatorDefaultSeed, 'INBOX', {
        id: '1700000001:43',
        subject: 'yolk-conformance trash probe: safe to delete'
      })
    )

    expect(call(emulator, synthetic('trash-untrash-to-inbox.delete'))).toHaveProperty('response')
    expect(emulator.state()).toEqual(emailEmulatorDefaultSeed)
  })

  it('answers a failed Sent copy only while the named Sent folder is missing', () => {
    const recorded = fixture('email.smtp.sent-copy-statuses.send-failed.synthetic')

    expect(makeEmailEmulator().call(recorded.method, recorded.request)).toEqual({
      response: recorded.response
    })

    const withFolder = makeEmailEmulator({
      seed: {
        folders: [
          ...emailEmulatorDefaultSeed.folders,
          { name: 'yolk-conformance-missing-sent-folder', messages: [] }
        ]
      }
    })

    expect(withFolder.call(recorded.method, recorded.request)).toEqual({
      notEmulated: {
        reason: 'state-conflict: no matching fixture is consistent with the emulated mailbox'
      }
    })
  })

  it('types every fixture as exactly one of response or failure', () => {
    const neither = { id: 'x', port: 'EmailClient', method: 'getMessage', request: {} }
    // @ts-expect-error a fixture needs a response or a failure
    const invalid: EmailEmulatorFixture = neither

    expect(invalid).toBe(neither)
    expect(
      emailEmulatorFixtures.every(
        recorded => (recorded.response === undefined) !== (recorded.failure === undefined)
      )
    ).toBe(true)
  })

  it('saves a Sent copy only when the fixture reports one saved', () => {
    const emulator = makeEmailEmulator()

    for (const step of ['send-skipped', 'send-failed', 'send-saved']) {
      const recorded = fixture(`email.smtp.sent-copy-statuses.${step}.synthetic`)

      expect(emulator.call(recorded.method, recorded.request), step).toEqual({
        response: recorded.response
      })
    }

    expect(emulator.state()).toEqual(
      withMessage(emailEmulatorDefaultSeed, 'Sent Items', {
        subject: 'yolk-conformance send: saved copy'
      })
    )
  })

  it('prefers fixtures not used since the last reset among equally consistent ones', () => {
    const emulator = makeEmailEmulator()

    emulator.call('listMessages', listFixture.request)
    emulator.call('listMessages', listFixture.request)
    emulator.call('listMessages', listFixture.request)

    expect(emulator.ledger.entries().map(entry => entry.fixtureId)).toEqual([
      'email.imap.list-and-get-headers.list.synthetic',
      'email.imap.list-and-get-headers.list-again.synthetic',
      'email.imap.list-and-get-headers.list.synthetic'
    ])
  })
})

describe('email emulator: faults, reset, coverage', () => {
  it('answers matching calls with the fault failure, counts them, and changes no state', () => {
    const emulator = makeEmailEmulator()

    const added = emulator.faults.add({
      kind: 'failure',
      method: 'setRead',
      match: { isRead: true },
      count: 1,
      failure
    })

    expect(added).toMatchObject({ id: 1, remaining: 1, applied: 0 })
    expect(call(emulator, synthetic('set-read-and-flag.set-read'))).toEqual({ failure })
    expect(emulator.state()).toEqual(emailEmulatorDefaultSeed)
    // Exhausted after one call: the next matching call is answered from the fixtures.
    expect(call(emulator, synthetic('set-read-and-flag.set-read'))).toHaveProperty('response')
    expect(emulator.faults.list()).toEqual([{ ...added, remaining: 0, applied: 1 }])
    expect(emulator.ledger.entries().map(entry => [entry.outcome, entry.faultId ?? null])).toEqual([
      ['fault', 1],
      ['answered', null]
    ])
  })

  it('never applies a fault to a call no fixture would answer, and keeps the fault available', () => {
    const emulator = makeEmailEmulator()

    const added = emulator.faults.add({ kind: 'failure', method: 'listMessages', failure })

    // Unmatched: no fixture covers this request.
    expect(emulator.call('listMessages', { connection: imap, limit: 7 })).toEqual({
      notEmulated: { reason: 'no-matching-fixture: no fixture matches this request' }
    })

    const trashFault = emulator.faults.add({ kind: 'failure', method: 'trash', count: 1, failure })

    // State-conflicting: the draft to trash was never created.
    expect(call(emulator, synthetic('trash-untrash-to-inbox.trash'))).toEqual({
      notEmulated: {
        reason: 'state-conflict: no matching fixture is consistent with the emulated mailbox'
      }
    })
    expect(emulator.faults.list()).toEqual([added, trashFault])
    expect(emulator.ledger.entries().map(entry => [entry.outcome, entry.reason ?? null])).toEqual([
      ['not-emulated', 'no-matching-fixture'],
      ['not-emulated', 'state-conflict']
    ])

    // A matching, consistent call then consumes the fault and changes no state.
    expect(emulator.call('listMessages', listFixture.request)).toEqual({ failure })
    expect(emulator.faults.list()[0]).toMatchObject({ applied: 1 })
    expect(emulator.state()).toEqual(emailEmulatorDefaultSeed)
  })

  it('matches faults as a deep subset of the credential-free request', () => {
    const emulator = makeEmailEmulator()

    emulator.faults.add({
      kind: 'failure',
      method: 'listMessages',
      match: { connection: { protocol: 'pop3' } },
      failure
    })

    expect(emulator.call('listMessages', listFixture.request)).toHaveProperty('response')
    expect(call(emulator, 'email.pop3.rejects-folders-drafts-mutations.list.synthetic')).toEqual({
      failure
    })
  })

  it('rejects invalid faults with EmailEmulatorInputInvalid', () => {
    const emulator = makeEmailEmulator()

    const invalid: ReadonlyArray<unknown> = [
      { kind: 'failure', method: 'modifyLabels', failure },
      { kind: 'failure', method: 'setRead', failure, count: 0 },
      { kind: 'failure', method: 'setRead', failure, extra: true },
      { kind: 'status', method: 'setRead', failure },
      { kind: 'failure', method: 'setRead', failure: { kind: 'defect', code: 'x', message: '' } }
    ]

    for (const input of invalid) {
      expect(() => emulator.faults.add(untyped<EmailEmulatorFault>(input))).toThrow(
        EmailEmulatorInputInvalid
      )
    }

    expect(emulator.faults.list()).toEqual([])
  })

  it('reset restores the seed and clears the ledger, faults, and fixture use', () => {
    const emulator = makeEmailEmulator()

    emulator.faults.add({ kind: 'failure', method: 'move', failure } satisfies EmailEmulatorFault)
    call(emulator, synthetic('set-read-and-flag.set-read'))
    emulator.reset()

    expect(emulator.state()).toEqual(emailEmulatorDefaultSeed)
    expect(emulator.ledger.entries()).toEqual([])
    expect(emulator.faults.list()).toEqual([])
    expect(emulator.coverage().unusedFixtureIds).toHaveLength(emailEmulatorFixtures.length)
  })

  it('reports calls per manifest route, refusals, and unused fixtures', () => {
    const emulator = makeEmailEmulator()

    emulator.call('listMessages', listFixture.request)
    emulator.call('unknownMethod', {})

    const coverage = emulator.coverage()

    expect(coverage.routes.map(route => [route.path, route.calls])).toEqual(
      emailEmulatorRoutes.map(route => [
        route.path,
        route.path === 'EmailClient.listMessages' ? 1 : 0
      ])
    )
    expect(coverage.notEmulatedCalls).toBe(1)
    expect(coverage.unusedFixtureIds).not.toContain(listFixture.id)
    expect(coverage.unusedFixtureIds).toHaveLength(emailEmulatorFixtures.length - 1)

    emulator.ledger.clear()
    expect(emulator.ledger.entries()).toEqual([])
  })
})

describe('email emulator: seed', () => {
  it('defaults to the synthetic practice mailbox and never shares state between emulators', () => {
    const first = makeEmailEmulator()
    const second = makeEmailEmulator()

    call(first, synthetic('set-read-and-flag.set-read'))

    expect(second.state()).toEqual(emailEmulatorDefaultSeed)
    expect(first.seed()).toEqual(emailEmulatorDefaultSeed)
  })

  it('rejects invalid seeds', () => {
    const inbox = emailEmulatorDefaultSeed.folders[0] ?? expect.fail('no INBOX')

    const invalid: ReadonlyArray<unknown> = [
      { folders: [inbox, inbox] },
      { folders: [{ ...inbox, messages: [...inbox.messages, ...inbox.messages] }] },
      { folders: [{ name: 'INBOX', messages: [], extra: true }] },
      { folders: [{ name: 'INBOX', specialUse: '\\Inbox', messages: [] }] },
      { folders: [{ name: '', messages: [] }] }
    ]

    for (const seed of invalid) {
      expect(() => makeEmailEmulator({ seed: untyped<EmailEmulatorSeed>(seed) })).toThrow(
        EmailEmulatorInputInvalid
      )
    }
  })

  it('carries no credential, socket, or mail-library surface: only plain JSON', () => {
    expect(JSON.parse(JSON.stringify(emailEmulatorFixtures))).toEqual(emailEmulatorFixtures)
    expect(JSON.stringify(emailEmulatorFixtures)).not.toMatch(/password|credential/i)
  })
})
