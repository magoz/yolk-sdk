import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Option, Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  decodePortFixture,
  scanPortFixtureForSecrets,
  type PortFixture
} from '@yolk-sdk/conformance/fixture'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ConnectorError, UsernamePasswordCredential } from '@yolk-sdk/connectors'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'
import {
  EmailClient,
  EmailConnector,
  EmailGetMessageRequest,
  EmailImapConnection,
  EmailListMessagesRequest,
  EmailSendMessageRequest,
  EmailSentCopyRequest,
  EmailSmtpConnection,
  EmailComposeMessage,
  EmailBody,
  EmailAddress
} from '@yolk-sdk/connectors/email'
import {
  EmailConformanceConfig,
  emailBackendMethods,
  emailClientFromBackend,
  emailClientLayerFromBackend,
  emailConformanceCases,
  emailConformanceFixtureSeeds,
  emailConformanceFixtures,
  emailMessageNotFoundCode,
  emailPortName,
  emailPortRequestJson,
  makeEmailReplayBackend,
  type EmailBackend,
  type EmailBackendReply,
  type EmailConformanceCase,
  type EmailConformanceSeeds,
  type EmailReplay
} from '@yolk-sdk/connectors/email/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const syntheticPassword = 'synthetic-practice-password'

const credentialLayer = staticCredentialResolverLayer(
  UsernamePasswordCredential.make({
    username: 'practice@example.test',
    password: syntheticPassword
  })
)

const fixturesFor = (
  testCase: Pick<EmailConformanceCase, 'fixtures'>,
  fixtures: ReadonlyArray<PortFixture> = emailConformanceFixtures
) => testCase.fixtures.flatMap(id => fixtures.filter(fixture => fixture.id === id))

/** Per-case replay layer; `replays` receives each case's replay so tests can read its ledger. */
const replayLayer =
  (
    replays: Map<string, EmailReplay> = new Map(),
    fixtures: ReadonlyArray<PortFixture> = emailConformanceFixtures,
    seeds: EmailConformanceSeeds = emailConformanceFixtureSeeds
  ) =>
  (testCase: EmailConformanceCase) =>
    Layer.mergeAll(
      Layer.suspend(() => {
        const replay = makeEmailReplayBackend(fixturesFor(testCase, fixtures))

        replays.set(testCase.id, replay)

        return emailClientLayerFromBackend(replay.backend)
      }),
      credentialLayer,
      Layer.succeed(EmailConformanceConfig, seeds)
    )

const replayTarget: ConformanceTarget = { kind: 'replay' }

const resultsById = (report: { readonly results: ReadonlyArray<{ readonly id: string }> }) =>
  report.results.map(result => result.id)

describe('email conformance cases', () => {
  it('declare their safety, stay unverified, and cite existing fixtures in order', () => {
    expect(emailConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual([
      ['email.imap.list-and-get-headers', 'read'],
      ['email.imap.filtered-list-no-fallback', 'read'],
      ['email.imap.draft-drafts-discovery', 'write-reversible'],
      ['email.imap.set-read-and-flag', 'write-reversible'],
      ['email.imap.trash-untrash-to-inbox', 'write-reversible'],
      ['email.imap.move-destination-ids', 'write-reversible'],
      ['email.pop3.rejects-folders-drafts-mutations', 'read'],
      ['email.smtp.sent-copy-statuses', 'write-irreversible'],
      ['email.smtp.legacy-host-sent-copy', 'write-irreversible'],
      ['email.smtp.acceptance-not-delivery', 'write-irreversible']
    ])

    // Every fixture backs exactly one case, in case order.
    expect(emailConformanceCases.flatMap(testCase => testCase.fixtures)).toEqual(
      emailConformanceFixtures.map(fixture => fixture.id)
    )

    for (const testCase of emailConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures.every(id => id.startsWith(`${testCase.id}.`))).toBe(true)
    }
  })

  it.effect('ship synthetic port fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      const methods: ReadonlyArray<string> = emailBackendMethods

      expect(new Set(emailConformanceFixtures.map(fixture => fixture.id)).size).toBe(
        emailConformanceFixtures.length
      )

      for (const fixture of emailConformanceFixtures) {
        expect(yield* decodePortFixture(fixture)).toEqual(fixture)
        expect(scanPortFixtureForSecrets(fixture)).toEqual([])
        expect(fixture.observed).toBeUndefined()
        expect(fixture.port).toBe(emailPortName)
        expect(methods).toContain(fixture.method)

        const text = JSON.stringify(fixture)

        // Synthetic hosts and addresses only, and no credential ever recorded.
        for (const host of text.match(/[a-z0-9.-]+\.(?:com|net|org|io)\b/g) ?? []) {
          expect.fail(`non-synthetic host in ${fixture.id}: ${host}`)
        }

        expect(text).not.toContain('credential')
        expect(text).not.toContain('password')
      }
    })
  )
})

describe('email conformance on replay', () => {
  it.effect('every case passes against its own fixtures and consumes all of them', () =>
    Effect.gen(function* () {
      const replays = new Map<string, EmailReplay>()

      const report = yield* runConformance(emailConformanceCases, {
        target: replayTarget,
        now,
        fixtures: emailConformanceFixtures,
        layer: replayLayer(replays)
      })

      expect(conformanceReportFailed(report), formatConformanceReport(report)).toBe(false)
      expect(report.summary).toEqual({ passed: 10, failed: 0, skipped: 0 })

      for (const testCase of emailConformanceCases) {
        const replay = replays.get(testCase.id)

        expect(replay?.ledger.remaining(), testCase.id).toEqual([])
        expect(
          replay?.ledger.entries().map(entry => entry.fixtureId ?? entry.outcome),
          testCase.id
        ).toEqual(testCase.fixtures)
      }

      // Every result carries the unverified warnings: synthetic placeholders, no live observation.
      for (const result of report.results) {
        expect(result.warnings[0]).toEqual({ kind: 'unverified-case' })
        expect(
          result.warnings.slice(1).every(warning => warning.kind === 'unverified-fixture')
        ).toBe(true)
      }
    })
  )

  it.effect('replayed requests never carry credentials', () =>
    Effect.gen(function* () {
      const replays = new Map<string, EmailReplay>()

      yield* runConformance(emailConformanceCases, {
        target: replayTarget,
        now,
        layer: replayLayer(replays)
      })

      const requests = [...replays.values()].flatMap(replay =>
        replay.ledger.entries().map(entry => JSON.stringify(entry.request))
      )

      expect(requests.length).toBe(emailConformanceFixtures.length)

      for (const request of requests) {
        expect(request).not.toContain(syntheticPassword)
        expect(request).not.toContain('credential')
      }
    })
  )

  it.effect('dropping one fixture fails exactly the case that cites it', () =>
    Effect.gen(function* () {
      for (const target of emailConformanceCases) {
        const dropped = target.fixtures.at(-1)

        if (dropped === undefined) {
          continue
        }

        const report = yield* runConformance(emailConformanceCases, {
          target: replayTarget,
          now,
          layer: replayLayer(
            new Map(),
            emailConformanceFixtures.filter(fixture => fixture.id !== dropped)
          )
        })

        expect(
          report.results.filter(result => result.status === 'failed').map(result => result.id),
          dropped
        ).toEqual([target.id])
      }
    })
  )

  it.effect('a stale-source failure other than message_not_found fails the move case', () =>
    Effect.gen(function* () {
      const staleId = 'email.imap.move-destination-ids.get-stale-source.synthetic'

      const throttled = emailConformanceFixtures.map((fixture): PortFixture =>
        fixture.id === staleId && fixture.failure !== undefined
          ? {
              ...fixture,
              failure: { kind: 'expected', code: 'rate_limited', message: 'Slow down.' }
            }
          : fixture
      )

      expect(throttled).not.toEqual(emailConformanceFixtures)

      const report = yield* runConformance(emailConformanceCases, {
        target: replayTarget,
        now,
        layer: replayLayer(new Map(), throttled)
      })

      expect(
        report.results.filter(result => result.status === 'failed').map(result => result.id)
      ).toEqual(['email.imap.move-destination-ids'])
      expect(
        report.results.find(result => result.id === 'email.imap.move-destination-ids')?.failure
          ?.message
      ).toBe('expected the stale source id to answer message_not_found after the move')
      expect(emailMessageNotFoundCode).toBe('message_not_found')
    })
  )

  it('the POP3 case claims every mailbox mutation action the connector ships', () => {
    const pop3 = emailConformanceCases.find(
      testCase => testCase.id === 'email.pop3.rejects-folders-drafts-mutations'
    )

    const mutations = EmailConnector.actions
      .filter(action => action.access !== 'read' && action.id !== 'email.send_message')
      .map(action => action.id)

    // create_draft plus 13 mutations (6 single-message, 6 batch, delete_permanently).
    expect(mutations).toHaveLength(14)

    for (const id of mutations) {
      expect(pop3?.wire, id).toContain(`\`${id}\``)
    }
  })

  it.effect('a missing seed fails the case as a precondition before any port call', () =>
    Effect.gen(function* () {
      const replays = new Map<string, EmailReplay>()

      const report = yield* runConformance(emailConformanceCases, {
        target: replayTarget,
        now,
        layer: replayLayer(replays, emailConformanceFixtures, {})
      })

      expect(report.summary).toEqual({ passed: 0, failed: 10, skipped: 0 })

      for (const result of report.results) {
        expect(result.failure?.message, result.id).toMatch(
          /^precondition: EmailConformanceConfig\.\w+ is not configured$/
        )
      }

      for (const replay of replays.values()) {
        expect(replay.ledger.entries()).toEqual([])
      }
    })
  )

  it.effect(
    'live targets gate writes: sends are manual-only, mailbox writes need reversible writes',
    () =>
      Effect.gen(function* () {
        const report = yield* runConformance(emailConformanceCases, {
          target: { kind: 'live', account: 'practice' },
          now,
          layer: replayLayer()
        })

        expect(
          report.results.map(result => [result.id, result.status, result.skipReason ?? null])
        ).toEqual([
          ['email.imap.list-and-get-headers', 'passed', null],
          ['email.imap.filtered-list-no-fallback', 'passed', null],
          ['email.imap.draft-drafts-discovery', 'skipped', 'writes-not-allowed'],
          ['email.imap.set-read-and-flag', 'skipped', 'writes-not-allowed'],
          ['email.imap.trash-untrash-to-inbox', 'skipped', 'writes-not-allowed'],
          ['email.imap.move-destination-ids', 'skipped', 'writes-not-allowed'],
          ['email.pop3.rejects-folders-drafts-mutations', 'passed', null],
          ['email.smtp.sent-copy-statuses', 'skipped', 'manual-only'],
          ['email.smtp.legacy-host-sent-copy', 'skipped', 'manual-only'],
          ['email.smtp.acceptance-not-delivery', 'skipped', 'manual-only']
        ])
        expect(resultsById(report)).toHaveLength(10)
      })
  )
})

const imap = EmailImapConnection.make({
  protocol: 'imap',
  host: 'imap.example.test',
  port: 993,
  security: 'tls'
})

const credential = UsernamePasswordCredential.make({
  username: 'practice@example.test',
  password: syntheticPassword
})

const listRequest = EmailListMessagesRequest.make({ connection: imap, credential, limit: 50 })

const getRequest = EmailGetMessageRequest.make({
  connection: imap,
  credential,
  messageId: '1700000001:41'
})

const backendOf = (reply: EmailBackendReply, seen: Array<Schema.Json> = []): EmailBackend => ({
  call: (_method, request) => {
    seen.push(request)

    return reply
  }
})

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

describe('email backend bridge', () => {
  it('sends credential-free plain JSON requests', () => {
    const sendRequest = EmailSendMessageRequest.make({
      connection: EmailSmtpConnection.make({
        protocol: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls'
      }),
      credential,
      message: EmailComposeMessage.make({
        to: [EmailAddress.make({ address: 'practice@example.test' })],
        body: EmailBody.make({ text: 'Hi' })
      }),
      sentCopy: EmailSentCopyRequest.make({ connection: imap, credential })
    })

    expect(emailPortRequestJson(sendRequest)).toEqual({
      connection: { protocol: 'smtp', host: 'smtp.example.test', port: 587, security: 'starttls' },
      message: { to: [{ address: 'practice@example.test' }], body: { text: 'Hi' } },
      sentCopy: {
        connection: { protocol: 'imap', host: 'imap.example.test', port: 993, security: 'tls' }
      }
    })
    expect(JSON.stringify(emailPortRequestJson(sendRequest))).not.toContain(syntheticPassword)
  })

  it.effect('decodes responses with the method output schema and maps failures', () =>
    Effect.gen(function* () {
      const seen: Array<Schema.Json> = []

      const listed = yield* emailClientFromBackend(
        backendOf({ response: { messages: [] } }, seen)
      ).listMessages(listRequest)

      expect(listed).toMatchObject({ _tag: 'Success', value: { messages: [] } })
      expect(seen).toEqual([
        {
          connection: { protocol: 'imap', host: 'imap.example.test', port: 993, security: 'tls' },
          limit: 50
        }
      ])

      const expected = yield* emailClientFromBackend(
        backendOf({
          failure: { kind: 'expected', code: 'message_not_found', message: 'gone', status: 404 }
        })
      ).getMessage(getRequest)

      expect(expected).toMatchObject({
        _tag: 'Failure',
        error: { code: 'message_not_found', message: 'gone', status: 404 }
      })

      const known = failureOf(
        yield* Effect.exit(
          emailClientFromBackend(
            backendOf({
              failure: { kind: 'error', code: 'credential_invalid', message: 'bad login' }
            })
          ).getMessage(getRequest)
        )
      )

      expect(known).toBeInstanceOf(ConnectorError)
      expect(known).toMatchObject({ cause: 'credential_invalid', message: 'bad login' })

      const unknownCause = failureOf(
        yield* Effect.exit(
          emailClientFromBackend(
            backendOf({ failure: { kind: 'error', code: 'socket_reset', message: 'reset' } })
          ).getMessage(getRequest)
        )
      )

      expect(unknownCause).toMatchObject({ cause: 'transport_failed' })
    })
  )

  it.effect('fails closed: not emulated, invalid output, and a throwing backend', () =>
    Effect.gen(function* () {
      const notEmulated = failureOf(
        yield* Effect.exit(
          emailClientFromBackend(
            backendOf({ notEmulated: { reason: 'no fixture matches this request' } })
          ).listMessages(listRequest)
        )
      )

      expect(notEmulated).toMatchObject({
        cause: 'transport_failed',
        message: 'EmailClient.listMessages is not emulated: no fixture matches this request'
      })

      const invalid = failureOf(
        yield* Effect.exit(
          emailClientFromBackend(backendOf({ response: { messages: 'nope' } })).listMessages(
            listRequest
          )
        )
      )

      expect(invalid).toMatchObject({
        cause: 'validation_failed',
        message: 'Email backend returned invalid listMessages output'
      })

      const throwing = failureOf(
        yield* Effect.exit(
          emailClientFromBackend({
            call: () => {
              throw new Error(`boom ${syntheticPassword}`)
            }
          }).listMessages(listRequest)
        )
      )

      expect(throwing).toMatchObject({
        cause: 'transport_failed',
        message: 'Email backend failed while answering EmailClient.listMessages'
      })
      expect(JSON.stringify(throwing)).not.toContain(syntheticPassword)
    })
  )

  it('bridges every JSON method but never raw attachment bytes', () => {
    const client = emailClientFromBackend(backendOf({ response: null }))

    for (const method of emailBackendMethods) {
      expect(Predicate.isFunction(client[method]), method).toBe(true)
    }

    expect(client.getAttachmentBytes).toBeUndefined()
  })

  it.effect('provides EmailClient through a layer', () =>
    Effect.gen(function* () {
      const client = yield* EmailClient

      expect(yield* client.listMessages(listRequest)).toMatchObject({ _tag: 'Success' })
    }).pipe(Effect.provide(emailClientLayerFromBackend(backendOf({ response: { messages: [] } }))))
  )
})

describe('email replay backend', () => {
  const [first, second] = emailConformanceFixtures

  it('answers each fixture at most once, taking the first unused match, and refuses anything else', () => {
    if (first === undefined || second === undefined) {
      return expect.fail('expected committed fixtures')
    }

    const replay = makeEmailReplayBackend([first, second])

    expect(replay.backend.call(second.method, second.request)).toEqual({
      response: 'response' in second ? second.response : null
    })
    expect(replay.backend.call(second.method, second.request)).toEqual({
      notEmulated: { reason: 'no unconsumed fixture matches this request' }
    })
    expect(replay.backend.call('getMessage', { messageId: 'other' })).toEqual({
      notEmulated: { reason: 'no unconsumed fixture matches this request' }
    })
    expect(replay.ledger.entries().map(entry => [entry.method, entry.outcome])).toEqual([
      [second.method, 'matched'],
      [second.method, 'unmatched'],
      ['getMessage', 'unmatched']
    ])
    expect(replay.ledger.remaining()).toEqual([first.id])
  })

  it('matches on the credential-free request and never ledgers credentials', () => {
    if (first === undefined) {
      return expect.fail('expected committed fixtures')
    }

    const replay = makeEmailReplayBackend([first])

    const withCredential: Schema.Json = {
      connection: {
        protocol: 'imap',
        host: 'imap.example.test',
        port: 993,
        security: 'tls'
      },
      limit: 50,
      credential: { username: 'practice@example.test', password: syntheticPassword }
    }

    expect(first.method).toBe('listMessages')

    expect(replay.backend.call(first.method, withCredential)).toHaveProperty('response')
    expect(JSON.stringify(replay.ledger.entries())).not.toContain(syntheticPassword)
  })

  it('answers failure fixtures as failures', () => {
    const failing = emailConformanceFixtures.find(fixture => fixture.failure !== undefined)

    if (failing?.failure === undefined) {
      return expect.fail('expected a failure fixture')
    }

    expect(makeEmailReplayBackend([failing]).backend.call(failing.method, failing.request)).toEqual(
      {
        failure: failing.failure
      }
    )
  })
})
