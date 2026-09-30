import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance
} from '@yolk-sdk/conformance/runner'
import { UsernamePasswordCredential } from '@yolk-sdk/connectors'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'
import {
  EmailConformanceConfig,
  emailBackendMethods,
  emailClientLayerFromBackend,
  emailConformanceCases,
  emailConformanceFixtureSeeds,
  emailConformanceFixtures,
  emailConformanceSubjects,
  type EmailConformanceCase
} from '@yolk-sdk/connectors/email/conformance'
import {
  emailEmulatorDefaultSeed,
  emailEmulatorFixtures,
  emailEmulatorRoutes,
  makeEmailEmulator,
  type EmailEmulator,
  type EmailEmulatorFault,
  type EmailEmulatorSeed
} from '../src/email.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const credentialLayer = staticCredentialResolverLayer(
  UsernamePasswordCredential.make({
    username: 'practice@example.test',
    password: 'synthetic-practice-password'
  })
)

/** The emulator is captured, so every case of one run shares its mailbox (cross-check A). */
const emulatorLayer = (emulator: EmailEmulator) => () =>
  Layer.mergeAll(
    emailClientLayerFromBackend(emulator),
    credentialLayer,
    Layer.succeed(EmailConformanceConfig, emailConformanceFixtureSeeds)
  )

const runOn = (emulator: EmailEmulator, cases: ReadonlyArray<EmailConformanceCase>) =>
  runConformance(cases, {
    target: { kind: 'in-process' },
    now,
    fixtures: emailConformanceFixtures,
    layer: emulatorLayer(emulator)
  })

/**
 * The documented changes a full run leaves behind: the one Sent copy the saved-copy send appends
 * (sent mail cannot be unsent). Every other case restores the mailbox.
 */
const withSavedCopy = (seed: EmailEmulatorSeed): EmailEmulatorSeed => ({
  folders: seed.folders.map(folder =>
    folder.name === 'Sent Items'
      ? {
          ...folder,
          messages: [...folder.messages, { subject: emailConformanceSubjects.sentSaved }]
        }
      : folder
  )
})

const documentedStateAfter = (caseIds: ReadonlyArray<string>): EmailEmulatorSeed =>
  caseIds.includes('email.smtp.sent-copy-statuses')
    ? withSavedCopy(emailEmulatorDefaultSeed)
    : emailEmulatorDefaultSeed

const failure = { kind: 'error', code: 'transport_failed', message: 'Synthetic drill.' } as const

/** One fault per case that makes exactly that case fail. */
const drills: ReadonlyArray<readonly [string, EmailEmulatorFault]> = [
  [
    'email.imap.list-and-get-headers',
    {
      kind: 'failure',
      method: 'listMessages',
      match: { connection: { protocol: 'imap' } },
      failure
    }
  ],
  [
    'email.imap.filtered-list-no-fallback',
    { kind: 'failure', method: 'listMessagesFiltered', failure }
  ],
  [
    'email.imap.draft-drafts-discovery',
    {
      kind: 'failure',
      method: 'createDraft',
      match: { message: { subject: emailConformanceSubjects.draftDiscovery } },
      failure
    }
  ],
  [
    'email.imap.set-read-and-flag',
    { kind: 'failure', method: 'setFlag', match: { isFlagged: true }, failure }
  ],
  [
    'email.imap.trash-untrash-to-inbox',
    { kind: 'failure', method: 'getMessage', match: { messageId: '1700000001:43' }, failure }
  ],
  [
    'email.imap.move-destination-ids',
    { kind: 'failure', method: 'getMessage', match: { messageId: '1700000005:12' }, failure }
  ],
  [
    'email.pop3.rejects-folders-drafts-mutations',
    {
      kind: 'failure',
      method: 'listMessages',
      match: { connection: { protocol: 'pop3' } },
      failure
    }
  ],
  [
    'email.smtp.sent-copy-statuses',
    {
      kind: 'failure',
      method: 'sendMessage',
      match: { message: { subject: emailConformanceSubjects.sentSaved } },
      failure
    }
  ],
  [
    'email.smtp.legacy-host-sent-copy',
    {
      kind: 'failure',
      method: 'sendMessage',
      match: { message: { subject: emailConformanceSubjects.legacyRequested } },
      failure
    }
  ],
  [
    'email.smtp.acceptance-not-delivery',
    {
      kind: 'failure',
      method: 'sendMessage',
      match: { message: { subject: emailConformanceSubjects.undeliverable } },
      failure
    }
  ]
]

describe('email emulator cross-check A (in-process)', () => {
  it.effect(
    'every case passes in one shared mailbox that ends as seeded, plus the documented Sent copy',
    () =>
      Effect.gen(function* () {
        const emulator = makeEmailEmulator()
        const report = yield* runOn(emulator, emailConformanceCases)

        expect(conformanceReportFailed(report), formatConformanceReport(report)).toBe(false)
        expect(report.summary).toEqual({ passed: 10, failed: 0, skipped: 0 })
        expect(emulator.state()).toEqual(
          documentedStateAfter(emailConformanceCases.map(({ id }) => id))
        )

        // Every fixture answered exactly once, in case order, and nothing failed closed.
        expect(emulator.ledger.entries().map(entry => entry.fixtureId ?? entry.outcome)).toEqual(
          emailConformanceFixtures.map(fixture => fixture.id)
        )
        expect(emulator.coverage()).toMatchObject({ notEmulatedCalls: 0, unusedFixtureIds: [] })
        expect(emulator.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
      })
  )

  it.effect('each case alone leaves the seeded mailbox, except the documented Sent copy', () =>
    Effect.gen(function* () {
      for (const testCase of emailConformanceCases) {
        const emulator = makeEmailEmulator()
        const report = yield* runOn(emulator, [testCase])

        expect(report.summary, `${testCase.id}\n${formatConformanceReport(report)}`).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })
        expect(emulator.state(), testCase.id).toEqual(documentedStateAfter([testCase.id]))
        expect(emulator.coverage().notEmulatedCalls, testCase.id).toBe(0)
      }
    })
  )

  it.effect('the suite passes again after reset', () =>
    Effect.gen(function* () {
      const emulator = makeEmailEmulator()

      yield* runOn(emulator, emailConformanceCases)
      emulator.reset()

      expect(emulator.state()).toEqual(emailEmulatorDefaultSeed)
      expect((yield* runOn(emulator, emailConformanceCases)).summary.failed).toBe(0)
    })
  )
})

describe('email emulator drills', () => {
  it('cover every case exactly once', () => {
    expect(drills.map(([caseId]) => caseId)).toEqual(emailConformanceCases.map(({ id }) => id))
  })

  it.effect('each drill fault fails exactly its targeted case, and restores still run', () =>
    Effect.gen(function* () {
      for (const [caseId, fault] of drills) {
        const emulator = makeEmailEmulator()

        emulator.faults.add(fault)

        const report = yield* runOn(emulator, emailConformanceCases)

        expect(
          report.results.filter(result => result.status === 'failed').map(result => result.id),
          `${caseId}\n${formatConformanceReport(report)}`
        ).toEqual([caseId])
        expect(
          emulator.ledger.entries().some(entry => entry.outcome === 'fault'),
          caseId
        ).toBe(true)

        // The failed case still cleaned up after itself (no drafts or moved messages left).
        const passedIds = report.results
          .filter(result => result.status === 'passed')
          .map(result => result.id)

        expect(emulator.state(), caseId).toEqual(documentedStateAfter(passedIds))
      }
    })
  )

  it.effect('a restore the fixtures cannot answer is reported, never swallowed', () =>
    Effect.gen(function* () {
      // Untrash fails, so the restore must delete the draft from the trash mailbox: no fixture
      // covers that call, so the emulator refuses it and the case reports the failed restore.
      const emulator = makeEmailEmulator()

      emulator.faults.add({ kind: 'failure', method: 'untrash', failure })

      const report = yield* runOn(emulator, [
        emailConformanceCases.find(({ id }) => id === 'email.imap.trash-untrash-to-inbox') ??
          expect.fail('no trash case')
      ])

      expect(report.results[0]?.failure).toMatchObject({ tag: 'EmailConformanceRestoreFailed' })
      expect(report.results[0]?.failure?.message).toContain(
        'remove the case-created message by hand'
      )
      expect(emulator.ledger.entries().at(-1)).toMatchObject({
        method: 'deletePermanently',
        outcome: 'not-emulated',
        reason: 'no-matching-fixture'
      })
      expect(
        emulator.state().folders.find(folder => folder.name === 'Deleted Items')?.messages
      ).toEqual([{ id: '1700000004:3', subject: emailConformanceSubjects.trashUntrash }])
    })
  )

  it.effect('a seed that disagrees with the fixtures fails closed instead of answering', () =>
    Effect.gen(function* () {
      const readSeed: EmailEmulatorSeed = {
        folders: emailEmulatorDefaultSeed.folders.map(folder =>
          folder.name === 'INBOX'
            ? {
                ...folder,
                messages: folder.messages.map(message => ({ ...message, isRead: true }))
              }
            : folder
        )
      }

      const emulator = makeEmailEmulator({ seed: readSeed })
      const report = yield* runOn(emulator, [emailConformanceCases[0] ?? expect.fail('no cases')])

      expect(report.summary.failed).toBe(1)
      expect(report.results[0]?.failure?.message).toContain('state-conflict')
      expect(emulator.ledger.entries().at(-1)).toMatchObject({
        outcome: 'not-emulated',
        reason: 'state-conflict'
      })
    })
  )
})

describe('email emulator fixture parity', () => {
  it('copies the connector email fixtures verbatim', () => {
    expect(emailEmulatorFixtures).toEqual(emailConformanceFixtures)
  })

  it('manifests exactly the methods the fixtures use, citing the cases that use them', () => {
    const fixtureMethods = [...new Set(emailEmulatorFixtures.map(fixture => fixture.method))].sort()
    const routeMethods = emailEmulatorRoutes.map(route => route.path.replace(/^EmailClient\./, ''))

    expect([...routeMethods].sort()).toEqual(fixtureMethods)

    const bridged: ReadonlyArray<string> = emailBackendMethods

    for (const route of emailEmulatorRoutes) {
      const method = route.path.replace(/^EmailClient\./, '')

      expect(route).toMatchObject({ method: 'PORT', kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
      expect(bridged).toContain(method)

      const citing = emailConformanceCases
        .filter(testCase =>
          testCase.fixtures.some(id =>
            emailConformanceFixtures.some(fixture => fixture.id === id && fixture.method === method)
          )
        )
        .map(testCase => testCase.id)

      expect(route.caseIds, method).toEqual(citing)
    }

    expect(emailEmulatorRoutes.filter(route => route.write).map(route => route.path)).toEqual([
      'EmailClient.createDraft',
      'EmailClient.sendMessage',
      'EmailClient.setRead',
      'EmailClient.setFlag',
      'EmailClient.trash',
      'EmailClient.untrash',
      'EmailClient.move',
      'EmailClient.deletePermanently'
    ])
  })

  it('seeds the mailbox the fixture seeds describe', () => {
    const folder = (name: string | undefined) =>
      emailEmulatorDefaultSeed.folders.find(candidate => candidate.name === name)

    const seeds = emailConformanceFixtureSeeds

    expect(folder(seeds.draftsFolder)?.specialUse).toBe('\\Drafts')
    expect(folder(seeds.sentFolder)?.specialUse).toBe('\\Sent')
    expect(folder(seeds.trashFolder)?.specialUse).toBe('\\Trash')
    expect(folder(seeds.moveDestinationFolder)).toBeDefined()
    expect(
      folder('INBOX')?.messages.find(message => message.id === seeds.unreadMessageId)
    ).toMatchObject({
      isRead: false,
      isFlagged: false
    })
    // Discovery must differ from a hard-coded fallback name.
    expect(seeds.draftsFolder).not.toBe('Drafts')
  })
})
