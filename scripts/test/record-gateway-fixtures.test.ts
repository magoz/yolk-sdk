import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceDefaultModels,
  vercelAiGatewayConformanceFixtures,
  vercelAiGatewayDeepSeekReasoningFixture,
  vercelAiGatewayErrorEnvelopeFixture,
  vercelAiGatewayPlainTextFixture
} from '../../packages/agent/src/providers/vercel/conformance/index.ts'
import {
  isWireStreamResponse,
  type WireChunk,
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import { recordBytes } from '../../packages/conformance/src/wire-internal.ts'
import {
  casesWithoutSingleFixture,
  defaultProbeOptions,
  dryRunReport,
  gatewayFixtureModuleFor,
  gatewayFixtureModules,
  gatewayFixtureNote,
  gatewayJsonRedactions,
  liveAccountRequiredMessage,
  parseProbeArgs,
  planGatewayProbe,
  redactJsonFields,
  redactRecording,
  renderFixtureModule,
  unredactedJsonFields,
  verifyGatewayFixtures,
  writeVerifiedFixtures,
  type FixtureWriter,
  type RecordedGatewayFixture
} from '../record-gateway-fixtures.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-gateway-fixtures.ts')

const caseIds = vercelAiGatewayConformanceCases.map(testCase => testCase.id)

// Probe options matching the committed recordings (the DeepSeek one used a `--reasoning-model`
// override), so replay verification sends the requests that were actually recorded.
const recordedOptions = parseProbeArgs([
  '--reasoning-model',
  String(
    vercelAiGatewayConformanceFixtures.find(
      fixture => fixture.caseId === 'vercel-ai-gateway.stream.deepseek-reasoning'
    )?.model ?? expect.fail('missing DeepSeek fixture')
  )
])

describe('record-gateway-fixtures arguments', () => {
  it('defaults to a dry run with the conformance default models and no account label', () => {
    expect(parseProbeArgs([])).toEqual(defaultProbeOptions)
    expect(defaultProbeOptions).toMatchObject({
      live: false,
      account: undefined,
      models: vercelAiGatewayConformanceDefaultModels,
      maxTokens: 64,
      reasoningMaxTokens: 512,
      reasoningEffort: 'low'
    })
  })

  it('requires an explicit --account label with --live', () => {
    expect(() => parseProbeArgs(['--live'])).toThrow(liveAccountRequiredMessage)
    expect(() => parseProbeArgs(['--live', '--plain-model', 'vendor/plain'])).toThrow(
      '--live requires --account <label>'
    )
    expect(parseProbeArgs(['--live', '--account', 'synthetic'])).toMatchObject({
      live: true,
      account: 'synthetic'
    })
    // Dry runs and help do not need a label.
    expect(parseProbeArgs(['--account=synthetic']).live).toBe(false)
    expect(parseProbeArgs(['--live', '--help']).help).toBe(true)
  })

  it('overrides each model and limit in both --flag value and --flag=value forms', () => {
    const options = parseProbeArgs([
      '--live',
      '--plain-model',
      'vendor/plain',
      '--reasoning-model=vendor/thinker',
      '--tool-model',
      'vendor/tools',
      '--invalid-model=vendor/missing',
      '--max-tokens=32',
      '--reasoning-max-tokens',
      '256',
      '--reasoning-effort',
      'high',
      '--account=synthetic'
    ])

    expect(options).toEqual({
      live: true,
      help: false,
      models: {
        plainText: 'vendor/plain',
        reasoning: 'vendor/thinker',
        toolCall: 'vendor/tools',
        invalid: 'vendor/missing'
      },
      maxTokens: 32,
      reasoningMaxTokens: 256,
      reasoningEffort: 'high',
      account: 'synthetic'
    })
    // Overrides never mutate the shared defaults.
    expect(defaultProbeOptions.models).toEqual(vercelAiGatewayConformanceDefaultModels)
    expect(parseProbeArgs(['--tool-model=vendor/tools']).models).toEqual({
      ...vercelAiGatewayConformanceDefaultModels,
      toolCall: 'vendor/tools'
    })
  })

  it('rejects unknown flags, missing values, and invalid numbers', () => {
    expect(() => parseProbeArgs(['--nope'])).toThrow('Unknown argument')
    expect(() => parseProbeArgs(['--tool-model'])).toThrow('requires a value')
    expect(() => parseProbeArgs(['--max-tokens=0'])).toThrow('positive integer')
    expect(() => parseProbeArgs(['--reasoning-effort=extreme'])).toThrow('must be one of')
  })
})

describe('record-gateway-fixtures plan', () => {
  it('maps every conformance case to its existing fixture file and export', () => {
    expect(caseIds).toEqual(gatewayFixtureModules.map(fixtureModule => fixtureModule.caseId))
    expect(
      caseIds.map(caseId => {
        const fixtureModule = gatewayFixtureModuleFor(caseId)

        return [caseId, fixtureModule?.fileName, fixtureModule?.exportName]
      })
    ).toEqual([
      ['vercel-ai-gateway.stream.plain-text', 'plain-text.ts', 'vercelAiGatewayPlainTextFixture'],
      [
        'vercel-ai-gateway.stream.deepseek-reasoning',
        'deepseek-reasoning.ts',
        'vercelAiGatewayDeepSeekReasoningFixture'
      ],
      [
        'vercel-ai-gateway.stream.tool-call-deltas',
        'tool-call-deltas.ts',
        'vercelAiGatewayToolCallDeltasFixture'
      ],
      [
        'vercel-ai-gateway.stream.error-envelope',
        'error-envelope.ts',
        'vercelAiGatewayErrorEnvelopeFixture'
      ]
    ])
    // The committed fixtures back the same cases the modules map.
    expect(vercelAiGatewayConformanceFixtures.map(fixture => fixture.caseId)).toEqual(caseIds)
  })

  it('plans each case with its model, token limit, and effort', () => {
    const models = vercelAiGatewayConformanceDefaultModels

    expect(
      planGatewayProbe(defaultProbeOptions).map(entry => [
        entry.testCase.id,
        entry.testCase.safety,
        entry.model,
        entry.maxTokens,
        entry.reasoningEffort
      ])
    ).toEqual([
      ['vercel-ai-gateway.stream.plain-text', 'read', models.plainText, 64, undefined],
      ['vercel-ai-gateway.stream.deepseek-reasoning', 'read', models.reasoning, 512, 'low'],
      ['vercel-ai-gateway.stream.tool-call-deltas', 'read', models.toolCall, 64, undefined],
      ['vercel-ai-gateway.stream.error-envelope', 'read', models.invalid, 64, undefined]
    ])
  })

  it('dry-runs every case id with the default models', () => {
    const report = dryRunReport(defaultProbeOptions)

    expect(report).toContain('DRY RUN: no network request was made')
    expect(report).toContain('verified by running the same cases on replay')

    for (const caseId of caseIds) {
      expect(report).toContain(`- ${caseId} [read]`)
    }

    for (const model of Object.values(vercelAiGatewayConformanceDefaultModels)) {
      expect(report).toContain(`model ${model}`)
    }

    expect(report).toContain('max tokens 512  reasoning effort low  -> deepseek-reasoning.ts')
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const fixtureModule = gatewayFixtureModuleFor(vercelAiGatewayPlainTextFixture.caseId)

    if (fixtureModule === undefined) {
      expect.fail('missing plain-text module')
    }

    const source = renderFixtureModule(fixtureModule, vercelAiGatewayPlainTextFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const vercelAiGatewayPlainTextFixture: WireFixture = {')
    expect(source).toContain(`"caseId": "${vercelAiGatewayPlainTextFixture.caseId}"`)
    expect(source).toContain(
      'Regenerate with\n * `pnpm conformance:gateway --live --account <label>`.'
    )
  })
})

// Strip DeepSeek reasoning (`reasoning_content` and the Gateway-normalized `reasoning`) from every
// parsed SSE `data:` payload: a recording the reasoning case must reject. Structural, so it holds
// for any recorded text.
const stripReasoningFromEvent = (event: string): string => {
  const data = event
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .join('\n')

  let json: unknown

  try {
    json = JSON.parse(data)
  } catch {
    return `${event}\n\n`
  }

  const choices =
    Predicate.hasProperty(json, 'choices') && Array.isArray(json.choices) ? json.choices : []

  for (const choice of choices) {
    if (Predicate.hasProperty(choice, 'delta') && Predicate.isObject(choice.delta)) {
      Reflect.deleteProperty(choice.delta, 'reasoning_content')
      Reflect.deleteProperty(choice.delta, 'reasoning')
    }
  }

  return `data: ${JSON.stringify(json)}\n\n`
}

const exchangeWithoutReasoning = (exchange: WireExchange): WireExchange => {
  const response = exchange.response

  if (!isWireStreamResponse(response)) {
    return exchange
  }

  const text = response.chunks
    .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
    .join('')
    .replace(/\r\n?/g, '\n')

  return {
    ...exchange,
    response: {
      ...response,
      chunks: text
        .split('\n\n')
        .filter(event => event.trim().length > 0)
        .map(stripReasoningFromEvent)
    }
  }
}

const withoutReasoning = (fixture: WireFixture): WireFixture => {
  const [first, ...rest] = structuredClone(fixture.exchanges)

  return {
    ...fixture,
    exchanges: [exchangeWithoutReasoning(first), ...rest.map(exchangeWithoutReasoning)]
  }
}

describe('record-gateway-fixtures replay verification', () => {
  it('passes every case against the committed fixtures', async () => {
    const report = await Effect.runPromise(
      verifyGatewayFixtures(vercelAiGatewayConformanceFixtures, recordedOptions)
    )

    expect(conformanceReportFailed(report)).toBe(false)
    expect(report.target).toEqual({ kind: 'replay' })
    expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
    expect(casesWithoutSingleFixture(vercelAiGatewayConformanceFixtures)).toEqual([])
  })

  it('fails the report for a tampered recording, so it would not be written', async () => {
    const tampered = vercelAiGatewayConformanceFixtures.map(fixture =>
      fixture.id === vercelAiGatewayDeepSeekReasoningFixture.id
        ? withoutReasoning(fixture)
        : fixture
    )

    const report = await Effect.runPromise(verifyGatewayFixtures(tampered, recordedOptions))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results.map(result => [result.id, result.status])).toEqual(
      caseIds.map(caseId => [
        caseId,
        caseId === vercelAiGatewayDeepSeekReasoningFixture.caseId ? 'failed' : 'passed'
      ])
    )
    expect(report.results[1]?.failure?.message).toBe('expected reasoning deltas')
  })

  it('fails the report when a case has no recording', async () => {
    const missing = vercelAiGatewayConformanceFixtures.filter(
      fixture => fixture.id !== vercelAiGatewayPlainTextFixture.id
    )

    const report = await Effect.runPromise(verifyGatewayFixtures(missing, recordedOptions))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results[0]).toMatchObject({
      id: 'vercel-ai-gateway.stream.plain-text',
      status: 'failed'
    })
    expect(casesWithoutSingleFixture(missing)).toEqual(['vercel-ai-gateway.stream.plain-text'])
  })
})

const placeholder =
  gatewayJsonRedactions.clientSessionId ?? expect.fail('no clientSessionId redaction')

// A fingerprint-shaped stand-in for a live session id: never a real recorded value.
const fakeSessionId = '0123456789abcdef0123456789abcdef'

// Put a live-looking session id back into a committed (redacted) recording.
const unredacted = (exchange: WireExchange): WireExchange => {
  const response = exchange.response

  return isWireStreamResponse(response)
    ? {
        ...exchange,
        response: {
          ...response,
          chunks: response.chunks.map(chunk =>
            Predicate.isString(chunk)
              ? chunk.replaceAll(
                  `"clientSessionId":"${placeholder}"`,
                  `"clientSessionId":"${fakeSessionId}"`
                )
              : chunk
          )
        }
      }
    : exchange
}

describe('record-gateway-fixtures redaction', () => {
  it('keeps the committed recordings fully redacted, with the redaction in their notes', () => {
    for (const fixture of vercelAiGatewayConformanceFixtures) {
      expect(unredactedJsonFields(fixture.exchanges, gatewayJsonRedactions)).toEqual([])
      expect(redactRecording(fixture.exchanges)).toEqual({
        exchanges: fixture.exchanges,
        redactedFields: [],
        unredactedFields: []
      })
    }

    const withSession = vercelAiGatewayConformanceFixtures.filter(fixture =>
      JSON.stringify(fixture.exchanges).includes('clientSessionId')
    )

    expect(withSession.map(fixture => fixture.id)).not.toContain(
      vercelAiGatewayErrorEnvelopeFixture.id
    )
    expect(withSession.length).toBeGreaterThan(0)

    for (const fixture of vercelAiGatewayConformanceFixtures) {
      expect(fixture.note).toBe(
        gatewayFixtureNote(withSession.includes(fixture) ? ['clientSessionId'] : [])
      )
    }

    expect(gatewayFixtureNote(['clientSessionId'])).toContain(
      'clientSessionId redacted after recording.'
    )
  })

  it('redacts a live session id from stream chunks, changing no other recorded byte', () => {
    for (const fixture of vercelAiGatewayConformanceFixtures) {
      const live = fixture.exchanges.map(unredacted)
      const redacted = redactRecording(live)
      const hadSession = JSON.stringify(live).includes(fakeSessionId)

      expect(redacted.redactedFields).toEqual(hadSession ? ['clientSessionId'] : [])
      expect(redacted.unredactedFields).toEqual([])
      // Chunk boundaries and every other byte match the committed recording.
      expect(redacted.exchanges).toEqual(fixture.exchanges)
    }
  })

  it('redacts request bodies and text bodies, keeping whitespace and neighbouring fields', () => {
    const exchanges: ReadonlyArray<WireExchange> = [
      {
        request: {
          method: 'POST',
          url: 'https://example.test/v1',
          body: {
            clientSessionId: fakeSessionId,
            nested: [{ clientSessionId: fakeSessionId, keep: 'value' }],
            count: 1
          }
        },
        response: {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: `{"clientSessionId" : "${fakeSessionId}","clientSessionIdSource":"fingerprint"}`
        }
      },
      {
        request: { method: 'GET', url: 'https://example.test/v1' },
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [`data: {"a":1,"clientSessionId":"${fakeSessionId}"}\n\n`, { base64: 'AAEC' }]
        }
      }
    ]

    expect(redactJsonFields(exchanges, gatewayJsonRedactions)).toEqual([
      {
        request: {
          method: 'POST',
          url: 'https://example.test/v1',
          body: {
            clientSessionId: placeholder,
            nested: [{ clientSessionId: placeholder, keep: 'value' }],
            count: 1
          }
        },
        response: {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: `{"clientSessionId" : "${placeholder}","clientSessionIdSource":"fingerprint"}`
        }
      },
      {
        request: { method: 'GET', url: 'https://example.test/v1' },
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [`data: {"a":1,"clientSessionId":"${placeholder}"}\n\n`, { base64: 'AAEC' }]
        }
      }
    ])
    expect(redactRecording(exchanges).redactedFields).toEqual(['clientSessionId'])
    expect(redactRecording(exchanges).unredactedFields).toEqual([])
  })

  it('reports a value split across network chunks as unredacted, so the probe refuses to write', () => {
    const split: ReadonlyArray<WireExchange> = [
      {
        request: { method: 'POST', url: 'https://example.test/v1' },
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [
            `data: {"clientSessionId":"${fakeSessionId.slice(0, 8)}`,
            `${fakeSessionId.slice(8)}"}\n\n`
          ]
        }
      }
    ]

    expect(redactRecording(split).unredactedFields).toEqual(['clientSessionId'])
  })

  it('reports a value inside a base64 body or chunk as unredacted, leaving the bytes untouched', () => {
    const json = `{"clientSessionId":"${fakeSessionId}"}`
    const base64 = Buffer.from(json, 'utf8').toString('base64')

    const exchanges: ReadonlyArray<WireExchange> = [
      {
        request: { method: 'POST', url: 'https://example.test/v1' },
        response: { status: 200, headers: {}, bodyBase64: base64 }
      },
      {
        request: { method: 'POST', url: 'https://example.test/v1' },
        response: { status: 200, headers: {}, chunks: ['data: ', { base64 }, '\n\n'] }
      }
    ]

    for (const exchange of exchanges) {
      const redacted = redactRecording([exchange])

      expect(redacted.unredactedFields).toEqual(['clientSessionId'])
      expect(redacted.exchanges).toEqual([exchange])
    }
  })
})

// A live-shaped plain-text recording whose session id sits in `{ base64 }` chunks: the chunk that
// carries it is split inside the multibyte `\u2192` before it, so (as `WireRecorder` does for bytes
// that are not valid UTF-8 on their own) both halves are recorded as base64.
const splitMultibyteRecording = (): WireFixture => {
  const fixture = vercelAiGatewayPlainTextFixture
  const [exchange, ...rest] = fixture.exchanges
  const live = unredacted(exchange)
  const response = live.response

  if (!isWireStreamResponse(response)) {
    return expect.fail('plain-text recording is not a stream')
  }

  const chunks = response.chunks.flatMap((chunk): ReadonlyArray<WireChunk> => {
    if (!Predicate.isString(chunk) || !chunk.includes(fakeSessionId)) {
      return [chunk]
    }

    const bytes = new TextEncoder().encode(chunk)
    const arrow = new TextEncoder().encode(chunk.slice(0, chunk.indexOf('\u2192'))).length

    expect(chunk.indexOf('\u2192')).toBeGreaterThan(-1)
    expect(chunk.indexOf('\u2192')).toBeLessThan(chunk.indexOf(fakeSessionId))

    return [bytes.subarray(0, arrow + 1), bytes.subarray(arrow + 1)].map(part => {
      const recorded = recordBytes(part)

      return 'text' in recorded ? recorded.text : { base64: recorded.base64 }
    })
  })

  return { ...fixture, exchanges: [{ ...live, response: { ...response, chunks } }, ...rest] }
}

describe('record-gateway-fixtures write gate', () => {
  type WriterCall = { readonly kind: 'write' | 'format'; readonly paths: ReadonlyArray<string> }

  const recordingWriter = () => {
    const calls: Array<WriterCall> = []

    const writer: FixtureWriter = {
      writeFile: path => {
        calls.push({ kind: 'write', paths: [path] })
      },
      formatFiles: paths => {
        calls.push({ kind: 'format', paths: [...paths] })
      }
    }

    return { calls, writer }
  }

  // Fake live recordings: each planned case paired with a fixture, no network involved.
  const recordedFrom = (
    fixtures: ReadonlyArray<WireFixture>
  ): ReadonlyArray<RecordedGatewayFixture> =>
    planGatewayProbe(recordedOptions).flatMap(entry =>
      fixtures.flatMap(fixture =>
        fixture.caseId === entry.testCase.id ? [{ entry, fixture }] : []
      )
    )

  it('writes every fixture module, then formats them, only after replay verification passes', async () => {
    const { calls, writer } = recordingWriter()

    const result = await Effect.runPromise(
      writeVerifiedFixtures(
        recordedFrom(vercelAiGatewayConformanceFixtures),
        recordedOptions,
        writer
      )
    )

    const fileNames = gatewayFixtureModules.map(fixtureModule => fixtureModule.fileName)

    expect(conformanceReportFailed(result.report)).toBe(false)
    expect(result.files.map(file => basename(file))).toEqual(fileNames)
    expect(calls).toEqual([
      ...result.files.map(file => ({ kind: 'write', paths: [file] })),
      { kind: 'format', paths: result.files }
    ])
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { calls, writer } = recordingWriter()

    const tampered = vercelAiGatewayConformanceFixtures.map(fixture =>
      fixture.id === vercelAiGatewayDeepSeekReasoningFixture.id
        ? withoutReasoning(fixture)
        : fixture
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(tampered), recordedOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'no fixture was written'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a session id survives in base64 chunks split mid-character', async () => {
    const { calls, writer } = recordingWriter()
    const split = splitMultibyteRecording()
    const splitResponse = split.exchanges[0]?.response

    const splitChunks =
      splitResponse !== undefined && isWireStreamResponse(splitResponse)
        ? splitResponse.chunks
        : expect.fail('split recording is not a stream')

    const committedResponse = vercelAiGatewayPlainTextFixture.exchanges[0].response

    const committedChunks = isWireStreamResponse(committedResponse)
      ? committedResponse.chunks
      : expect.fail('plain-text recording is not a stream')

    // The session id now lives only in base64 chunks, one more than the committed recording.
    expect(splitChunks).toHaveLength(committedChunks.length + 1)
    expect(splitChunks.filter(chunk => !Predicate.isString(chunk))).toHaveLength(2)
    expect(JSON.stringify(splitChunks)).not.toContain(fakeSessionId)

    // Redaction cannot rewrite it and never re-chunks, so the survivor is reported.
    const redacted = redactRecording(split.exchanges)

    expect(redacted.unredactedFields).toEqual(['clientSessionId'])
    expect(redacted.exchanges).toEqual(split.exchanges)

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(
          vercelAiGatewayConformanceFixtures.map(fixture =>
            fixture.id === split.id ? split : fixture
          )
        ),
        recordedOptions,
        writer
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not redact clientSessionId from the recording: the value is inside a base64 body or chunk'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a case has no recording', async () => {
    const { calls, writer } = recordingWriter()

    const missing = vercelAiGatewayConformanceFixtures.filter(
      fixture => fixture.id !== vercelAiGatewayPlainTextFixture.id
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(missing), recordedOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('record-gateway-fixtures CLI', () => {
  it('dry-runs by default without needing a Gateway key', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, probeScript],
        { cwd: repoRoot, env: { ...process.env, AI_GATEWAY_API_KEY: '' } },
        (error, stdout) => {
          resolvePromise({ failed: error !== null, stdout: String(stdout) })
        }
      )
    })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')

    for (const caseId of caseIds) {
      expect(result.stdout).toContain(caseId)
    }
  })
})
