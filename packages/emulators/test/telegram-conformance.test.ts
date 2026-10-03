/**
 * Cross-checks: the Telegram emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the REAL Telegram connector actions and the host-only
 * `downloadTelegramFile` helper, both in-process (A) and over a loopback socket (B); and each drill
 * knob must make exactly its case fail. The bot token is in every URL path: no ledger, state, or
 * coverage may ever carry it. Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  TelegramConformanceConfig,
  telegramConformanceCases,
  telegramConformanceFixtureSeeds
} from '@yolk-sdk/connectors/telegram/conformance'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import {
  makeTelegramEmulator,
  telegramEmulatorDefaultOrigin,
  type TelegramEmulator,
  type TelegramEmulatorDrills,
  type TelegramEmulatorOptions,
  type TelegramEmulatorState,
  type TelegramLedgerEntry
} from '../src/telegram.ts'

const origin = telegramEmulatorDefaultOrigin

const now = new Date('2026-09-30T12:00:00.000Z')

/** A synthetic token, not the fixtures' replay token: any well-formed token is accepted. */
const botToken = '424242:yolk-emulator-cross-check-token'

/** The error case's synthetic token that names no bot. */
const invalidToken = '0:yolk-conformance-invalid-token'

const credentialLayer = staticCredentialResolverLayer(ApiKeyCredential.make({ key: botToken }))

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(TelegramConformanceConfig, telegramConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: TelegramEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(origin, emulator.fetch)])

const emulatedLayer = (emulator: TelegramEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(origin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

type Emulators = ReadonlyMap<string, TelegramEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: TelegramEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, TelegramEmulator>()

      for (const testCase of telegramConformanceCases) {
        emulators.set(
          testCase.id,
          await makeTelegramEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const emulatorFor = (emulators: Emulators, caseId: string): TelegramEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: TelegramEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(telegramConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = telegramConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<TelegramLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.path} ${entry.status}`)

const sendCaseId = 'telegram.messages.send-message'

/** Nothing the emulator keeps or reports carries either token, in any form. */
const expectNoToken = (emulator: TelegramEmulator) => {
  const recorded = JSON.stringify([
    emulator.ledger.entries(),
    emulator.snapshot(),
    emulator.coverage(),
    emulator.faults.list()
  ])

  for (const token of [botToken, invalidToken]) {
    expect(recorded).not.toContain(token)
    expect(recorded).not.toContain(encodeURIComponent(token))
    expect(recorded).not.toContain(token.split(':')[1])
  }
}

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means: the read cases leave the exact seed; the irreversible send case
  // adds exactly its sent message to `sentMessages` and advances the message counter (documented:
  // nothing can unsend it, as in Telegram), and leaves everything else at the seed.
  it.effect(
    'passes every Telegram case (the irreversible send included); only the send changes the state',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(report.results.map(result => [result.id, result.safety])).toEqual([
            ['telegram.validate.get-chat', 'read'],
            ['telegram.errors.error-envelope', 'read'],
            ['telegram.files.get-file-path', 'read'],
            [sendCaseId, 'write-irreversible']
          ])

          const seedOf = (id: string): TelegramEmulatorState => {
            const seed = seeds.get(id)

            if (seed === undefined) throw new Error(`no seed for ${id}`)

            return seed
          }

          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          for (const testCase of telegramConformanceCases.filter(item => item.safety === 'read')) {
            expect(stateOf(testCase.id), testCase.id).toEqual(seedOf(testCase.id))
          }

          const sent = stateOf(sendCaseId)

          expect({ ...sent, sentMessages: [], counters: seedOf(sendCaseId).counters }).toEqual(
            seedOf(sendCaseId)
          )
          expect(sent.sentMessages).toEqual([
            {
              message_id: 101,
              chat_id: -1001000000001,
              text: 'yolk-conformance run-synthetic: synthetic conformance message, safe to ignore',
              date: Math.floor(now.getTime() / 1000),
              disable_web_page_preview: true
            }
          ])
          expect(sent.counters).toEqual({ nextMessageId: 102 })

          // Token-free ledger paths, the route templates, and the recorded statuses.
          expect(requests(ledgerOf('telegram.validate.get-chat'))).toEqual([
            'POST /bot<redacted>/getChat 200'
          ])
          expect(requests(ledgerOf('telegram.errors.error-envelope'))).toEqual([
            'POST /bot<redacted>/getChat 400',
            'POST /bot<redacted>/getChat 401'
          ])
          expect(requests(ledgerOf('telegram.files.get-file-path'))).toEqual([
            'GET /bot<redacted>/getFile 200',
            'GET /file/bot<redacted>/documents/file_0.txt 200'
          ])
          expect(requests(ledgerOf(sendCaseId))).toEqual(['POST /bot<redacted>/sendMessage 200'])
          expect(ledgerOf(sendCaseId)[0]?.route).toBe('/bot{token}/sendMessage')

          for (const emulator of emulators.values()) {
            expectNoToken(emulator)
          }
        })
      ),
    60_000
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect(
    'passes every Telegram case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of telegramConformanceCases) {
            const emulator = emulatorFor(emulators, testCase.id)
            const seed = seeds.get(testCase.id)

            if (seed === undefined) throw new Error(`no seed for ${testCase.id}`)

            expect(emulator.ledger.entries().length, testCase.id).toBeGreaterThan(0)
            expect(
              emulator.ledger.entries().every(entry => entry.evidence === 'unverified'),
              testCase.id
            ).toBe(true)
            expectNoToken(emulator)

            // The same end-at-seed proof as cross-check A: the read cases leave the exact seed;
            // the irreversible send adds exactly its one message and advances the counter.
            if (testCase.id === sendCaseId) {
              const sent = emulator.snapshot()

              expect({ ...sent, sentMessages: [], counters: seed.counters }).toEqual(seed)
              expect(sent.sentMessages).toEqual([
                {
                  message_id: 101,
                  chat_id: -1001000000001,
                  text: 'yolk-conformance run-synthetic: synthetic conformance message, safe to ignore',
                  date: Math.floor(now.getTime() / 1000),
                  disable_web_page_preview: true
                }
              ])
              expect(sent.counters).toEqual({ nextMessageId: 102 })
            } else {
              expect(emulator.snapshot(), testCase.id).toEqual(seed)
            }
          }
        })
      ),
    60_000
  )
})

const drill = (drills: TelegramEmulatorDrills) =>
  withEmulators({ drills }, emulators => runAll(emulators, { kind: 'in-process' }, inProcessLayer))

describe('disagreement drills (tests-only knobs): each fails exactly its case', () => {
  it.effect.each([
    [
      { getChatOkFalse: true },
      'telegram.validate.get-chat',
      'ConformanceMismatch',
      'expected the 2xx getChat answer to carry ok: true'
    ],
    [
      { errorsAs200: true },
      'telegram.errors.error-envelope',
      'ConformanceMismatch',
      'expected telegram.validate to fail for a chat the bot is not a member of'
    ],
    [
      { fileSizeOffByOne: true },
      'telegram.files.get-file-path',
      'TelegramConformanceActionFailed',
      'partial_content'
    ],
    [{ sendOkFalse: true }, sendCaseId, 'TelegramConformanceActionFailed', 'send outcome unknown']
  ] as const)(
    '%o fails only %s',
    ([drills, id, tag, message]) =>
      Effect.gen(function* () {
        const report = yield* drill(drills)

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: caseCount - 1,
          failed: 1,
          skipped: 0
        })

        const failed = report.results.filter(result => result.status === 'failed')

        expect(failed.map(result => result.id)).toEqual([id])
        expect(failed[0]?.failure?.tag).toBe(tag)
        expect(failed[0]?.failure?.message).toContain(message)
      }),
    60_000
  )
})
