import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  anthropicConformanceCases,
  anthropicConformanceDefaultModels,
  anthropicConformanceFixtures,
  anthropicMessagesPlainTextFixture,
  anthropicMessagesThinkingBeforeTextFixture,
  anthropicMessagesToolUseInputDeltasFixture
} from '../../packages/agent/src/providers/anthropic/conformance/index.ts'
import {
  isWireStreamResponse,
  type WireChunk,
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import { recordBytes } from '../../packages/conformance/src/wire-internal.ts'
import {
  anthropicApiKeyEnv,
  anthropicFixtureModuleFor,
  anthropicFixtureModules,
  anthropicPermittedNonJsonPayloads,
  casesWithoutSingleFixture,
  defaultProbeOptions,
  dryRunReport,
  liveAccountRequiredMessage,
  parseProbeArgs,
  planAnthropicProbe,
  redactedSignature,
  redactedThinkingData,
  redactThinkingSignatures,
  renderFixtureModule,
  thinkingRedactionRefusal,
  unredactedThinkingFields,
  unscannableThinkingPayloads,
  verifyAnthropicFixtures,
  writeVerifiedFixtures,
  type FixtureWriter,
  type RecordedAnthropicFixture
} from '../record-anthropic-fixtures.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-anthropic-fixtures.ts')

const caseIds = anthropicConformanceCases.map(testCase => testCase.id)

describe('record-anthropic-fixtures arguments', () => {
  it('defaults to a dry run with the conformance default models and no account label', () => {
    expect(parseProbeArgs([])).toEqual(defaultProbeOptions)
    expect(defaultProbeOptions).toMatchObject({
      live: false,
      account: undefined,
      models: anthropicConformanceDefaultModels,
      maxTokens: 64,
      thinkingBudgetTokens: 1024
    })
    expect(anthropicApiKeyEnv).toBe('ANTHROPIC_API_KEY')
  })

  it('requires an explicit --account label with --live', () => {
    expect(() => parseProbeArgs(['--live'])).toThrow(liveAccountRequiredMessage)
    expect(parseProbeArgs(['--live', '--account', 'synthetic'])).toMatchObject({
      live: true,
      account: 'synthetic'
    })
    expect(parseProbeArgs(['--account=synthetic']).live).toBe(false)
    expect(parseProbeArgs(['--live', '--help']).help).toBe(true)
  })

  it('overrides each model and limit in both --flag value and --flag=value forms', () => {
    expect(
      parseProbeArgs([
        '--live',
        '--plain-model',
        'example-plain',
        '--tool-model=example-tools',
        '--thinking-model',
        'example-thinking',
        '--invalid-model=example-missing',
        '--max-tokens',
        '32',
        '--thinking-budget-tokens=2048',
        '--account=synthetic'
      ])
    ).toEqual({
      live: true,
      help: false,
      models: {
        plainText: 'example-plain',
        toolUse: 'example-tools',
        thinking: 'example-thinking',
        invalid: 'example-missing'
      },
      maxTokens: 32,
      thinkingBudgetTokens: 2048,
      account: 'synthetic'
    })
    expect(defaultProbeOptions.models).toEqual(anthropicConformanceDefaultModels)
  })

  it('rejects unknown flags, missing values, and invalid numbers', () => {
    expect(() => parseProbeArgs(['--nope'])).toThrow('Unknown argument')
    expect(() => parseProbeArgs(['--tool-model'])).toThrow('requires a value')
    expect(() => parseProbeArgs(['--max-tokens=0'])).toThrow('positive integer')
    expect(() => parseProbeArgs(['--thinking-budget-tokens=512'])).toThrow('at least 1024')
  })
})

describe('record-anthropic-fixtures plan', () => {
  it('maps every conformance case to its existing fixture file and export', () => {
    expect(caseIds).toEqual(anthropicFixtureModules.map(fixtureModule => fixtureModule.caseId))
    expect(
      caseIds.map(caseId => {
        const fixtureModule = anthropicFixtureModuleFor(caseId)

        return [caseId, fixtureModule?.fileName, fixtureModule?.exportName]
      })
    ).toEqual([
      [
        'anthropic.messages.stream.plain-text',
        'plain-text.ts',
        'anthropicMessagesPlainTextFixture'
      ],
      [
        'anthropic.messages.stream.tool-use-input-deltas',
        'tool-use-input-deltas.ts',
        'anthropicMessagesToolUseInputDeltasFixture'
      ],
      [
        'anthropic.messages.stream.thinking-before-text',
        'thinking-before-text.ts',
        'anthropicMessagesThinkingBeforeTextFixture'
      ],
      [
        'anthropic.messages.stream.error-envelope',
        'error-envelope.ts',
        'anthropicMessagesErrorEnvelopeFixture'
      ],
      ['anthropic.messages.stream.max-tokens', 'max-tokens.ts', 'anthropicMessagesMaxTokensFixture']
    ])
    expect(anthropicConformanceFixtures.map(fixture => fixture.caseId)).toEqual(caseIds)
  })

  it('plans each case with its model and max_tokens', () => {
    const models = anthropicConformanceDefaultModels

    expect(
      planAnthropicProbe(defaultProbeOptions).map(entry => [
        entry.testCase.id,
        entry.testCase.safety,
        entry.model,
        entry.maxTokens
      ])
    ).toEqual([
      ['anthropic.messages.stream.plain-text', 'read', models.plainText, 64],
      ['anthropic.messages.stream.tool-use-input-deltas', 'read', models.toolUse, 64],
      ['anthropic.messages.stream.thinking-before-text', 'read', models.thinking, 64 + 1024],
      ['anthropic.messages.stream.error-envelope', 'read', models.invalid, 64],
      ['anthropic.messages.stream.max-tokens', 'read', models.plainText, 8]
    ])
  })

  it('plans the recorded request limits the committed fixtures carry', () => {
    for (const entry of planAnthropicProbe(defaultProbeOptions)) {
      const fixture = anthropicConformanceFixtures.find(
        candidate => candidate.caseId === entry.testCase.id
      )

      expect(fixture?.exchanges[0].request.body, entry.testCase.id).toMatchObject({
        model: entry.model,
        max_tokens: entry.maxTokens
      })
    }
  })

  it('dry-runs every case id with the default models', () => {
    const report = dryRunReport(defaultProbeOptions)

    expect(report).toContain('DRY RUN: no network request was made')
    expect(report).toContain('needs ANTHROPIC_API_KEY')
    expect(report).toContain('Endpoint: https://api.anthropic.com/v1/messages')

    for (const caseId of caseIds) {
      expect(report).toContain(`- ${caseId} [read]`)
    }

    for (const model of Object.values(anthropicConformanceDefaultModels)) {
      expect(report).toContain(`model ${model}`)
    }
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const fixtureModule = anthropicFixtureModuleFor(anthropicMessagesPlainTextFixture.caseId)

    if (fixtureModule === undefined) {
      expect.fail('missing plain-text module')
    }

    const source = renderFixtureModule(fixtureModule, anthropicMessagesPlainTextFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const anthropicMessagesPlainTextFixture: WireFixture = {')
    expect(source).toContain(
      'Regenerate with\n * `pnpm conformance:anthropic --live --account <label>`.'
    )
  })
})

const streamChunks = (exchange: WireExchange): ReadonlyArray<WireChunk> => {
  const response = exchange.response

  return isWireStreamResponse(response) ? response.chunks : expect.fail('not a stream')
}

const withChunks = (exchange: WireExchange, chunks: ReadonlyArray<WireChunk>): WireExchange => ({
  request: exchange.request,
  response: {
    status: exchange.response.status,
    headers: exchange.response.headers,
    chunks: [...chunks]
  }
})

const jsonExchange = (content: ReadonlyArray<unknown>): WireExchange => ({
  request: anthropicMessagesPlainTextFixture.exchanges[0].request,
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', content })
  }
})

const responseBody = (exchange: WireExchange): string => {
  const response = exchange.response

  return 'body' in response && Predicate.isString(response.body)
    ? response.body
    : expect.fail('not a text body')
}

const signatureChunkIndex = (chunks: ReadonlyArray<WireChunk>): number =>
  chunks.findIndex(chunk => Predicate.isString(chunk) && chunk.includes('"signature_delta"'))

// The committed thinking recording with its `signature_delta` event recorded as one `{ base64 }`
// chunk between text chunks, as `WireRecorder` stores bytes it cannot keep as text.
const mixedBase64Recording = (): WireExchange => {
  const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
  const chunks = streamChunks(exchange)
  const index = signatureChunkIndex(chunks)
  const chunk = chunks[index]

  if (!Predicate.isString(chunk)) {
    return expect.fail('no signature_delta chunk')
  }

  return withChunks(exchange, [
    ...chunks.slice(0, index),
    { base64: Buffer.from(chunk, 'utf8').toString('base64') },
    ...chunks.slice(index + 1)
  ])
}

// The committed thinking recording with the thinking text ending in the multibyte `\u2192` and the
// signature event in the same network read, split inside that character: neither half is valid
// UTF-8 on its own, so (as `WireRecorder` does) both are recorded as base64.
const splitUtf8Recording = (): WireExchange => {
  const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
  const chunks = streamChunks(exchange)
  const index = signatureChunkIndex(chunks)
  const signatureChunk = chunks[index]
  const thinkingChunk = chunks[index - 1]

  if (!Predicate.isString(signatureChunk) || !Predicate.isString(thinkingChunk)) {
    return expect.fail('unexpected thinking recording shape')
  }

  const withArrow = thinkingChunk.replace('enough."', 'enough \u2192"')

  expect(withArrow).not.toBe(thinkingChunk)

  const joined = `${withArrow}${signatureChunk}`
  const bytes = new TextEncoder().encode(joined)
  const cut = new TextEncoder().encode(joined.slice(0, joined.indexOf('\u2192'))).length + 1

  const parts = [bytes.subarray(0, cut), bytes.subarray(cut)].map((part): WireChunk => {
    const recorded = recordBytes(part)

    return 'text' in recorded ? recorded.text : { base64: recorded.base64 }
  })

  expect(parts.every(part => !Predicate.isString(part))).toBe(true)

  return withChunks(exchange, [...chunks.slice(0, index - 1), ...parts, ...chunks.slice(index + 1)])
}

// The committed thinking recording with the signature value itself split across two text chunks.
const splitValueRecording = (): WireExchange => {
  const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
  const chunks = streamChunks(exchange)
  const index = signatureChunkIndex(chunks)
  const chunk = chunks[index]

  if (!Predicate.isString(chunk)) {
    return expect.fail('no signature_delta chunk')
  }

  const cut = chunk.indexOf('synthetic-thinking-signature') + 'synthetic-thinking'.length

  return withChunks(exchange, [
    ...chunks.slice(0, index),
    chunk.slice(0, cut),
    chunk.slice(cut),
    ...chunks.slice(index + 1)
  ])
}

// The committed thinking recording whose `signature_delta` carries `signature` twice: the real
// value first, cut across two text chunks (so chunk-by-chunk redaction cannot rewrite it), then
// the placeholder, the only value `JSON.parse` of the reassembled payload keeps.
const splitDuplicateSignatureRecording = (): WireExchange => {
  const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
  const chunks = streamChunks(exchange)
  const index = signatureChunkIndex(chunks)
  const original = chunks[index]

  if (!Predicate.isString(original)) {
    return expect.fail('no signature_delta chunk')
  }

  const chunk = original.replace(
    '"signature":"synthetic-thinking-signature"',
    `"signature":"synthetic-thinking-signature","signature":"${redactedSignature}"`
  )

  expect(chunk).not.toBe(original)

  const cut = chunk.indexOf('synthetic-thinking-signature') + 'synthetic-thinking'.length

  return withChunks(exchange, [
    ...chunks.slice(0, index),
    chunk.slice(0, cut),
    chunk.slice(cut),
    ...chunks.slice(index + 1)
  ])
}

// The committed thinking recording whose `signature_delta` spells its key `"sign\u0061ture"` (an
// escaped `signature`, which chunk redaction never sees) and carries a member nested past the
// scanner's depth limit, so the payload cannot be member-scanned.
const escapedSignatureBehindDeepNesting = (): WireExchange => {
  const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
  const chunks = streamChunks(exchange)
  const index = signatureChunkIndex(chunks)
  const original = chunks[index]

  if (!Predicate.isString(original)) {
    return expect.fail('no signature_delta chunk')
  }

  const chunk = original.replace(
    '"signature":"synthetic-thinking-signature"',
    `${String.raw`"sign\u0061ture"`}:"synthetic-thinking-signature","deep":${'['.repeat(300)}${']'.repeat(300)}`
  )

  expect(chunk).not.toBe(original)

  return withChunks(exchange, [...chunks.slice(0, index), chunk, ...chunks.slice(index + 1)])
}

// The committed thinking recording plus an invalid-JSON `signature_delta` event carrying a value.
const invalidSignaturePayloadRecording = (): WireExchange => {
  const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges

  return withChunks(exchange, [
    ...streamChunks(exchange),
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"synthetic-thinking-signature"\n\n'
  ])
}

describe('record-anthropic-fixtures signature redaction', () => {
  it('redacts thinking signatures chunk by chunk, keeping every boundary and other byte', () => {
    const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
    const chunks = streamChunks(exchange)
    const redacted = redactThinkingSignatures(exchange)
    const redactedChunks = streamChunks(redacted)

    expect(unredactedThinkingFields([exchange])).toEqual(['signature'])
    expect(unredactedThinkingFields([redacted])).toEqual([])
    expect(redactedChunks).toHaveLength(chunks.length)
    expect(redactedChunks).toEqual(
      chunks.map(chunk =>
        Predicate.isString(chunk)
          ? chunk.replace('"synthetic-thinking-signature"', `"${redactedSignature}"`)
          : chunk
      )
    )
    // The empty signature on `content_block_start` stays as recorded.
    expect(redactedChunks.join('')).toContain('"signature":""')
    // Idempotent: a redacted recording is returned as is.
    expect(redactThinkingSignatures(redacted)).toBe(redacted)
  })

  it('leaves exchanges without signatures untouched', () => {
    const [plain] = anthropicMessagesPlainTextFixture.exchanges
    const [tool] = anthropicMessagesToolUseInputDeltasFixture.exchanges

    expect(redactThinkingSignatures(plain)).toBe(plain)
    expect(redactThinkingSignatures(tool)).toBe(tool)
    expect(unredactedThinkingFields([plain, tool])).toEqual([])
  })

  it('replaces signatures in a JSON message body', () => {
    const exchange = jsonExchange([
      { type: 'thinking', thinking: 'Plan.', signature: 'synthetic-json-signature' },
      { type: 'text', text: 'Hello.' }
    ])

    const redacted = redactThinkingSignatures(exchange)

    expect(responseBody(redacted)).toContain(`"signature":"${redactedSignature}"`)
    expect(JSON.stringify(redacted)).not.toContain('synthetic-json-signature')
    expect(unredactedThinkingFields([exchange])).toEqual(['signature'])
    expect(unredactedThinkingFields([redacted])).toEqual([])
  })

  it('redacts redacted_thinking data in content_block_start and in JSON content[]', () => {
    const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
    const chunks = streamChunks(exchange)

    const start = (block: Record<string, string>) =>
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: block
      })}\n\n`

    // Both key orders, and an empty `data` that stays as recorded.
    const stream = withChunks(exchange, [
      chunks[0] ?? expect.fail('empty recording'),
      start({ type: 'redacted_thinking', data: 'synthetic-encrypted-data-a' }),
      start({ data: 'synthetic-encrypted-data-b', type: 'redacted_thinking' }),
      start({ type: 'redacted_thinking', data: '' }),
      ...chunks.slice(1)
    ])

    const body = jsonExchange([
      { type: 'redacted_thinking', data: 'synthetic-encrypted-data-c' },
      { type: 'text', text: 'Hello.' }
    ])

    expect(unredactedThinkingFields([stream])).toEqual(['signature', 'redacted_thinking.data'])
    expect(unredactedThinkingFields([body])).toEqual(['redacted_thinking.data'])

    const redacted = [stream, body].map(redactThinkingSignatures)
    const serialized = JSON.stringify(redacted)

    expect(unredactedThinkingFields(redacted)).toEqual([])
    expect(serialized).not.toContain('synthetic-encrypted-data')
    expect(serialized).toContain(redactedThinkingData)
    expect(streamChunks(redacted[0] ?? expect.fail('no stream'))).toHaveLength(chunks.length + 3)
    expect(streamChunks(redacted[0] ?? expect.fail('no stream')).join('')).toContain(
      '"type":"redacted_thinking","data":""'
    )
  })

  it('never rewrites a base64 chunk: a signature there is reported, text chunks are redacted', () => {
    const mixed = mixedBase64Recording()
    const redacted = redactThinkingSignatures(mixed)
    const chunks = streamChunks(mixed)

    expect(chunks.some(chunk => !Predicate.isString(chunk))).toBe(true)
    expect(streamChunks(redacted)).toEqual(chunks)
    expect(unredactedThinkingFields([redacted])).toEqual(['signature'])
  })

  it('reports a signature split across text chunks or inside split UTF-8 base64 chunks', () => {
    for (const recording of [splitValueRecording(), splitUtf8Recording()]) {
      const redacted = redactThinkingSignatures(recording)

      expect(streamChunks(redacted)).toEqual(streamChunks(recording))
      expect(unredactedThinkingFields([redacted])).toEqual(['signature'])
    }
  })

  it('refuses a repeated signature whose first value crossed a chunk boundary', () => {
    const redacted = redactThinkingSignatures(splitDuplicateSignatureRecording())

    const payload =
      streamChunks(redacted)
        .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
        .join('')
        .split('\n')
        .find(line => line.includes('"signature_delta"'))
        ?.slice('data: '.length) ?? expect.fail('no signature_delta payload')

    // The first value survives on the wire, yet JSON.parse only keeps the trailing placeholder.
    expect(payload).toContain('"signature":"synthetic-thinking-signature"')
    expect(JSON.parse(payload)).toMatchObject({ delta: { signature: redactedSignature } })
    expect(unredactedThinkingFields([redacted])).toEqual(['signature'])
  })

  it('refuses repeated or non-string redacted values, and allows null, "", and placeholders', () => {
    const body = (text: string): WireExchange => ({
      request: anthropicMessagesPlainTextFixture.exchanges[0].request,
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: text }
    })

    const signature = JSON.stringify(redactedSignature)
    const data = JSON.stringify(redactedThinkingData)

    expect(
      unredactedThinkingFields([
        body(`{"content":[{"type":"thinking","signature":${signature},"signature":${signature}}]}`)
      ])
    ).toEqual(['signature'])
    expect(
      unredactedThinkingFields([
        body(`{"content":[{"type":"redacted_thinking","data":${data},"data":${data}}]}`)
      ])
    ).toEqual(['redacted_thinking.data'])
    expect(
      unredactedThinkingFields([
        body('{"content":[{"type":"thinking","signature":{"value":"synthetic"}}]}'),
        body('{"content":[{"type":"redacted_thinking","data":12345}]}')
      ])
    ).toEqual(['signature', 'redacted_thinking.data'])
    // A repeated `type` cannot hide a redacted_thinking block's data either.
    expect(
      unredactedThinkingFields([
        body(
          '{"content":[{"type":"redacted_thinking","data":"synthetic-encrypted","type":"text"}]}'
        )
      ])
    ).toEqual(['redacted_thinking.data'])
    expect(
      unredactedThinkingFields([
        body(
          `{"content":[{"type":"thinking","signature":null},{"type":"thinking","signature":""},{"type":"thinking","signature":${signature}},{"type":"redacted_thinking","data":${data}},{"type":"text","data":"not redacted thinking"}]}`
        )
      ])
    ).toEqual([])
  })

  it('refuses a payload that is not JSON, never falling back to a textual check', () => {
    const [exchange] = anthropicMessagesPlainTextFixture.exchanges

    const broken = [
      withChunks(exchange, ['data: {"signature":"synthetic-cut\n\n']),
      withChunks(exchange, ['data: {"type":"redacted_thinking",\n\n'])
    ]

    expect(unredactedThinkingFields(broken)).toEqual([])
    expect(unscannableThinkingPayloads(broken)).toBe(2)
    expect(thinkingRedactionRefusal(broken)).toContain('could not check 2 response payload')
  })

  it('refuses a payload nested past the scanner depth limit, whatever its keys', () => {
    const nested = escapedSignatureBehindDeepNesting()

    expect(redactThinkingSignatures(nested)).toBe(nested)
    expect(unscannableThinkingPayloads([nested])).toBe(1)
    expect(thinkingRedactionRefusal([nested])).toContain('could not check 1 response payload')
  })

  it('lets only the permitted non-JSON sentinels through', () => {
    const [exchange] = anthropicMessagesPlainTextFixture.exchanges
    const done = withChunks(exchange, [...streamChunks(exchange), 'data: [DONE]\n\n'])

    expect(anthropicPermittedNonJsonPayloads).toEqual(['[DONE]'])
    expect(unscannableThinkingPayloads([done])).toBe(0)
    expect(thinkingRedactionRefusal([done])).toBeUndefined()

    for (const payload of ['[done]', 'DONE', '[DONE] trailing', 'ping']) {
      const other = withChunks(exchange, [...streamChunks(exchange), `data: ${payload}\n\n`])

      expect(unscannableThinkingPayloads([other]), payload).toBe(1)
    }
  })

  it('refuses unknown SSE lines even when they parse as JSON, and a bare [DONE] line', () => {
    const [exchange] = anthropicMessagesPlainTextFixture.exchanges

    for (const line of [
      '{"note":"synthetic-private-note"}',
      '"synthetic-private-note"',
      '[DONE]',
      '42'
    ]) {
      const withLine = withChunks(exchange, [...streamChunks(exchange), `${line}\n\n`])

      expect(unscannableThinkingPayloads([withLine]), line).toBe(1)
      expect(thinkingRedactionRefusal([withLine]), line).toBeDefined()
    }
  })

  it('refuses base64 chunks and bodies that do not decode', () => {
    const [exchange] = anthropicMessagesPlainTextFixture.exchanges
    const badChunk = withChunks(exchange, [...streamChunks(exchange), { base64: '%%%' }])

    const badBody: WireExchange = {
      request: exchange.request,
      response: { status: 200, headers: exchange.response.headers, bodyBase64: '%%%' }
    }

    for (const bad of [badChunk, badBody]) {
      expect(unscannableThinkingPayloads([bad])).toBe(1)
      expect(thinkingRedactionRefusal([bad])).toBeDefined()
    }
  })

  it('refuses SSE comments, unknown fields, and malformed lines the parser would ignore', () => {
    const [exchange] = anthropicMessagesPlainTextFixture.exchanges

    for (const line of [': comment "sign\\u0061ture":"x"', 'x-trace: synthetic', 'not a field']) {
      const withLine = withChunks(exchange, [...streamChunks(exchange), `${line}\n\n`])

      expect(unscannableThinkingPayloads([withLine]), line).toBe(1)
      expect(thinkingRedactionRefusal([withLine]), line).toBeDefined()
    }

    const known = withChunks(exchange, [
      ...streamChunks(exchange),
      'event: ping\nid: 7\nretry: 1000\n\n'
    ])

    expect(unscannableThinkingPayloads([known])).toBe(0)
  })
})

// Strip every `input_json_delta` from the recorded stream: a recording the tool-use case must
// reject. Structural, so it holds for any recorded text and any fragment split.
const withoutToolInput = (fixture: WireFixture): WireFixture => {
  const [exchange] = fixture.exchanges
  const response = exchange.response

  if (!isWireStreamResponse(response)) {
    return fixture
  }

  const events = response.chunks
    .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .filter(event => event.trim().length > 0 && !event.includes('"input_json_delta"'))

  return {
    ...fixture,
    exchanges: [
      { ...exchange, response: { ...response, chunks: events.map(event => `${event}\n\n`) } }
    ]
  }
}

const tampered = () =>
  anthropicConformanceFixtures.map(fixture =>
    fixture.id === anthropicMessagesToolUseInputDeltasFixture.id
      ? withoutToolInput(fixture)
      : fixture
  )

describe('record-anthropic-fixtures replay verification', () => {
  it('passes every case against the committed fixtures', async () => {
    const report = await Effect.runPromise(verifyAnthropicFixtures(anthropicConformanceFixtures))

    expect(conformanceReportFailed(report)).toBe(false)
    expect(report.target).toEqual({ kind: 'replay' })
    expect(report.summary).toEqual({ passed: caseIds.length, failed: 0, skipped: 0 })
    expect(casesWithoutSingleFixture(anthropicConformanceFixtures)).toEqual([])
  })

  it('fails the report for a tampered recording, so it would not be written', async () => {
    const report = await Effect.runPromise(verifyAnthropicFixtures(tampered()))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results.map(result => [result.id, result.status])).toEqual(
      caseIds.map(caseId => [
        caseId,
        caseId === anthropicMessagesToolUseInputDeltasFixture.caseId ? 'failed' : 'passed'
      ])
    )
    // No input fragments assemble into `{}`, which lacks the claimed key.
    expect(report.results[1]?.failure?.message).toBe('expected a non-empty string `city` argument')
  })

  it('fails the report when a case has no recording', async () => {
    const missing = anthropicConformanceFixtures.filter(
      fixture => fixture.id !== anthropicMessagesPlainTextFixture.id
    )

    const report = await Effect.runPromise(verifyAnthropicFixtures(missing))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results[0]).toMatchObject({
      id: 'anthropic.messages.stream.plain-text',
      status: 'failed'
    })
    expect(casesWithoutSingleFixture(missing)).toEqual(['anthropic.messages.stream.plain-text'])
  })
})

describe('record-anthropic-fixtures write gate', () => {
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

  // Fake live recordings: each planned case paired with a fixture, no network involved, redacted
  // as the probe redacts every live recording before the write gate.
  const recordedFrom = (
    fixtures: ReadonlyArray<WireFixture>
  ): ReadonlyArray<RecordedAnthropicFixture> =>
    planAnthropicProbe(defaultProbeOptions).flatMap(entry =>
      fixtures.flatMap(fixture =>
        fixture.caseId === entry.testCase.id
          ? [
              {
                entry,
                fixture: {
                  ...fixture,
                  exchanges: [
                    redactThinkingSignatures(fixture.exchanges[0]),
                    ...fixture.exchanges.slice(1).map(redactThinkingSignatures)
                  ]
                }
              }
            ]
          : []
      )
    )

  const withThinkingExchange = (exchange: WireExchange): ReadonlyArray<WireFixture> =>
    anthropicConformanceFixtures.map(fixture =>
      fixture.id === anthropicMessagesThinkingBeforeTextFixture.id
        ? { ...fixture, exchanges: [exchange] }
        : fixture
    )

  it('writes every fixture module, then formats them, only after replay verification passes', async () => {
    const { calls, writer } = recordingWriter()

    const result = await Effect.runPromise(
      writeVerifiedFixtures(recordedFrom(anthropicConformanceFixtures), defaultProbeOptions, writer)
    )

    expect(conformanceReportFailed(result.report)).toBe(false)
    expect(result.files.map(file => basename(file))).toEqual(
      anthropicFixtureModules.map(fixtureModule => fixtureModule.fileName)
    )
    expect(result.files.every(file => file.includes('providers/anthropic/conformance'))).toBe(true)
    expect(calls).toEqual([
      ...result.files.map(file => ({ kind: 'write', paths: [file] })),
      { kind: 'format', paths: result.files }
    ])
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { calls, writer } = recordingWriter()

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(tampered()), defaultProbeOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'no fixture was written'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a signature survives in a base64 chunk, split UTF-8, or split chunks', async () => {
    for (const recording of [mixedBase64Recording(), splitUtf8Recording(), splitValueRecording()]) {
      const { calls, writer } = recordingWriter()

      const exit = await Effect.runPromiseExit(
        writeVerifiedFixtures(
          recordedFrom(withThinkingExchange(recording)),
          defaultProbeOptions,
          writer
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
        'could not redact signature from the recording'
      )
      expect(calls).toEqual([])
    }
  })

  it('writes nothing when a repeated signature hides a value split across chunks', async () => {
    const { calls, writer } = recordingWriter()
    const fixtures = withThinkingExchange(splitDuplicateSignatureRecording())

    // Replay alone would pass: the provider keeps whichever signature JSON.parse returns.
    const report = await Effect.runPromise(verifyAnthropicFixtures(fixtures))

    expect(conformanceReportFailed(report)).toBe(false)

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(fixtures), defaultProbeOptions, writer)
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not redact signature from the recording'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when redacted_thinking data survives in a base64 chunk', async () => {
    const { calls, writer } = recordingWriter()
    const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
    const chunks = streamChunks(exchange)

    const block = `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'synthetic-encrypted-data' }
    })}\n\n`

    const recording = withChunks(exchange, [
      ...chunks.slice(0, 1),
      { base64: Buffer.from(block, 'utf8').toString('base64') },
      ...chunks.slice(1)
    ])

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(withThinkingExchange(recording)),
        defaultProbeOptions,
        writer
      )
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not redact redacted_thinking.data from the recording'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when an escaped signature key hides behind nesting past the depth limit', async () => {
    const { calls, writer } = recordingWriter()
    const fixtures = withThinkingExchange(escapedSignatureBehindDeepNesting())

    // Replay alone would pass: JSON.parse reads the escaped key and the deep member fine.
    const report = await Effect.runPromise(verifyAnthropicFixtures(fixtures))

    expect(conformanceReportFailed(report)).toBe(false)

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(fixtures), defaultProbeOptions, writer)
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not check 1 response payload'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when an invalid JSON payload carries a signature', async () => {
    const { calls, writer } = recordingWriter()

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(withThinkingExchange(invalidSignaturePayloadRecording())),
        defaultProbeOptions,
        writer
      )
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not check 1 response payload'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a case has no recording', async () => {
    const { calls, writer } = recordingWriter()

    const missing = anthropicConformanceFixtures.filter(
      fixture => fixture.id !== anthropicMessagesPlainTextFixture.id
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(missing), defaultProbeOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('record-anthropic-fixtures CLI', () => {
  it('dry-runs by default without needing an Anthropic key', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, probeScript],
        { cwd: repoRoot, env: { ...process.env, [anthropicApiKeyEnv]: '' } },
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

  it('refuses --live without an account label before reading any credential', async () => {
    const result = await new Promise<{ failed: boolean; stderr: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, probeScript, '--live'],
        { cwd: repoRoot, env: { ...process.env, [anthropicApiKeyEnv]: '' } },
        (error, _stdout, stderr) => {
          resolvePromise({ failed: error !== null, stderr: String(stderr) })
        }
      )
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('--live requires --account <label>')
  })
})
