/**
 * The Gateway emulator's classifier route (`POST /v1/evaluate`): fixture-only answers, the
 * not-emulated rule, its own ledger, faults, scripted errors, control plane, and manifest, and
 * cross-checks: the classifier conformance cases pass against it through the real public Gateway
 * classifier, in-process and over a loopback socket, and its faults map through the provider.
 * Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Predicate, Redacted } from 'effect'
import type * as Schema from 'effect/Schema'
import { FetchHttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { runConformance } from '@yolk-sdk/conformance/runner'
import { ClassifierModel } from '@yolk-sdk/agent/classification'
import { makeVercelAiGatewayClassifierLayer } from '@yolk-sdk/agent/providers/vercel/ai-gateway-classifier'
import {
  VercelAiGatewayClassifierConformanceConfig,
  vercelAiGatewayClassifierConformanceCases,
  vercelAiGatewayClassifierConformanceDefaultModels,
  vercelAiGatewayClassifierBooleanCase,
  vercelAiGatewayClassifierBooleanFixture,
  vercelAiGatewayClassifierChoiceCase
} from '@yolk-sdk/agent/providers/vercel/conformance'
import {
  gatewayEmulatorRoutes,
  gatewayEvaluateEmulatorRoutes,
  gatewayEvaluatePath,
  makeGatewayEmulator,
  type GatewayEmulator
} from '../src/gateway.ts'
import { isJsonObject } from '../src/emulator-kernel.ts'
import { serveFetchHandler } from '../src/node.ts'
import { emulatorEvidenceHeader } from '../src/route-evidence.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const now = new Date('2026-10-02T12:00:00.000Z')

const origin = 'https://ai-gateway.vercel.sh'

const credential = 'synthetic-gateway-key'

const configLayer = Layer.succeed(VercelAiGatewayClassifierConformanceConfig, {
  apiKey: Redacted.make(credential),
  models: vercelAiGatewayClassifierConformanceDefaultModels
})

const inProcessLayer = (emulator: GatewayEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(origin, emulator.fetch)])

const emulatedLayer = (emulator: GatewayEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(origin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

const recordedBody = (): Schema.JsonObject => {
  const body = vercelAiGatewayClassifierBooleanFixture.exchanges[0].request.body

  return isJsonObject(body) ? { ...body } : expect.fail('no recorded body')
}

const recordedResponse = (): string => {
  const response = vercelAiGatewayClassifierBooleanFixture.exchanges[0].response

  return 'body' in response && Predicate.isString(response.body)
    ? response.body
    : expect.fail('no recorded response')
}

const post = (
  emulator: GatewayEmulator,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
) =>
  emulator.fetch(
    new Request(`${origin}${gatewayEvaluatePath}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
        ...headers
      },
      body: JSON.stringify(body)
    })
  )

describe('Gateway emulator classifier route', () => {
  it('lists /v1/evaluate as unverified provider evidence for the classifier cases', () => {
    expect(gatewayEvaluateEmulatorRoutes).toEqual([
      {
        method: 'POST',
        path: '/v1/evaluate',
        kind: 'provider',
        write: false,
        caseIds: vercelAiGatewayClassifierConformanceCases.map(testCase => testCase.id),
        evidence: 'unverified',
        observedAt: undefined
      }
    ])
    // The chat route's manifest is unchanged.
    expect(gatewayEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /v1/chat/completions'
    ])
  })

  it('answers the recorded request with the recorded response, evidence-tagged', async () => {
    const emulator = makeGatewayEmulator()
    const response = await post(emulator, recordedBody())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await response.text()).toBe(recordedResponse())

    expect(emulator.evaluate.ledger.entries()).toMatchObject([
      {
        method: 'POST',
        path: '/v1/evaluate',
        model: 'typesafe-ai/jev',
        credentialHeader: 'authorization',
        recording: vercelAiGatewayClassifierBooleanFixture.id,
        evidence: 'unverified',
        status: 200
      }
    ])
    expect(JSON.stringify(emulator.evaluate.ledger.entries())).not.toContain(credential)
    // The chat route's ledger stays its own.
    expect(emulator.ledger.entries()).toEqual([])
  })

  it('accepts other free text but answers 400 not-emulated for anything unrecorded', async () => {
    const emulator = makeGatewayEmulator()

    const reworded = { ...recordedBody(), state: 'Another synthetic reply.' }

    expect((await post(emulator, reworded)).status).toBe(200)

    const refusals: ReadonlyArray<
      readonly [string, Schema.JsonObject, Readonly<Record<string, string>>]
    > = [
      ['another model', { ...recordedBody(), model: 'typesafe-ai/other' }, {}],
      ['provider options', { ...recordedBody(), providerOptions: { gateway: {} } }, {}],
      ['other questions', { ...recordedBody(), questions: {} }, {}],
      ['no credential', recordedBody(), { authorization: '' }]
    ]

    for (const [label, body, headers] of refusals) {
      const response = await post(emulator, body, headers)

      expect(response.status, label).toBe(400)
      expect(await response.json(), label).toMatchObject({ error: { type: 'not_emulated' } })
    }

    expect(emulator.evaluate.ledger.entries().filter(entry => entry.notEmulated)).toHaveLength(4)
  })

  it('has its own faults, scripted errors, and control plane; reset clears both routes', async () => {
    const emulator = makeGatewayEmulator()

    emulator.evaluate.faults.add({ kind: 'status', status: 503, count: 1 })

    expect((await post(emulator, recordedBody())).status).toBe(503)
    expect((await post(emulator, recordedBody())).status).toBe(200)

    emulator.evaluate.script.enqueue({
      error: { status: 429, body: { message: 'Synthetic', error_type: 'rate_limit_exceeded' } }
    })

    expect((await post(emulator, recordedBody())).status).toBe(429)
    expect(() => emulator.evaluate.faults.add({ kind: 'status', status: 200 })).toThrow()

    const ledger = await emulator.fetch(new Request(`${origin}/_emulate/evaluate/ledger`))

    expect(ledger.status).toBe(200)
    expect(JSON.stringify(await ledger.json())).toContain('/v1/evaluate')

    await emulator.fetch(new Request(`${origin}/_emulate/reset`, { method: 'POST' }))

    expect(emulator.evaluate.ledger.entries()).toEqual([])
  })
})

describe('Gateway classifier conformance cases against the emulator', () => {
  it.effect('all pass in-process and over a loopback socket', () =>
    Effect.gen(function* () {
      for (const [kind, transport] of [
        ['in-process', inProcessLayer],
        ['emulated', emulatedLayer]
      ] as const) {
        const report = yield* runConformance(vercelAiGatewayClassifierConformanceCases, {
          target: { kind },
          now,
          layer: () => Layer.mergeAll(transport(makeGatewayEmulator()), configLayer)
        })

        expect(report.summary, kind).toEqual({ passed: 4, failed: 0, skipped: 0 })
      }
    })
  )

  it.effect('fail the right case for a faulted route', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(
        [vercelAiGatewayClassifierBooleanCase, vercelAiGatewayClassifierChoiceCase],
        {
          target: { kind: 'in-process' },
          now,
          layer: testCase => {
            const emulator = makeGatewayEmulator()

            if (testCase.id === vercelAiGatewayClassifierChoiceCase.id) {
              emulator.evaluate.faults.add({ kind: 'truncate-after-chunks', chunks: 0 })
            }

            return Layer.mergeAll(inProcessLayer(emulator), configLayer)
          }
        }
      )

      expect(report.results.map(result => result.status)).toEqual(['passed', 'failed'])
    })
  )

  it.effect('maps a 429 fault with retry-after through the real classifier', () =>
    Effect.gen(function* () {
      const emulator = makeGatewayEmulator()

      emulator.evaluate.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '3' }
      })

      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const model = yield* ClassifierModel

          // The recorded request shape: faults apply only to admitted requests.
          return yield* model.classify({
            state: 'Another synthetic reply.',
            questions: {
              approves: {
                type: 'boolean',
                instructions: 'Does the reply approve the delivered result?',
                criteria: { true: 'Approves.', false: 'Rejects.' }
              }
            }
          })
        }).pipe(
          Effect.provide(
            makeVercelAiGatewayClassifierLayer({ apiKey: Redacted.make(credential) }).pipe(
              Layer.provide(inProcessLayer(emulator))
            )
          )
        )
      )

      expect(error).toMatchObject({
        _tag: 'ClassificationProviderError',
        message: 'Vercel AI Gateway returned 429',
        retryable: true,
        provider: { kind: 'rate_limit', status: 429, retryAfterMs: 3000 }
      })
    })
  )
})
