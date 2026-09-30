import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  openAiCodexConformanceCases,
  openAiCodexConformanceDefaultModels,
  openAiCodexConformanceFixtures,
  openAiCodexFunctionCallArgumentsFixture,
  openAiCodexPlainTextFixture
} from '../../packages/agent/src/providers/openai/conformance/index.ts'
import {
  xAiGrokConformanceCases,
  xAiGrokConformanceDefaultModels,
  xAiGrokConformanceFixtures,
  xAiGrokPlainTextFixture
} from '../../packages/agent/src/providers/xai/conformance/index.ts'
import {
  isWireStreamResponse,
  type WireChunk,
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import {
  casesWithoutSingleFixture,
  clientVersionRequiredMessage,
  defaultProbeOptions,
  dryRunReport,
  familyRequiredMessage,
  isCiEnvironment,
  liveAccountRequiredMessage,
  liveInCiMessage,
  ownerApprovalRequiredMessage,
  parseProbeArgs,
  planResponsesProbe,
  probeModels,
  redactResponsesFields,
  renderFixtureModule,
  responsesFamilies,
  responsesFixtureModuleFor,
  responsesPermittedNonJsonPayloads,
  responsesRedactedValue,
  responsesRedactionRefusal,
  unredactedResponsesFields,
  unscannableResponsesPayloads,
  verifyResponsesFixtures,
  writeVerifiedFixtures,
  type FixtureWriter,
  type ProbeOptions,
  type RecordedResponsesFixture
} from '../record-responses-fixtures.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-responses-fixtures.ts')

const codexOptions: ProbeOptions = { ...defaultProbeOptions, family: 'codex' }

const grokOptions: ProbeOptions = { ...defaultProbeOptions, family: 'grok' }

const families = [
  {
    family: 'codex',
    options: codexOptions,
    cases: openAiCodexConformanceCases,
    fixtures: openAiCodexConformanceFixtures,
    dir: 'providers/openai/conformance'
  },
  {
    family: 'grok',
    options: grokOptions,
    cases: xAiGrokConformanceCases,
    fixtures: xAiGrokConformanceFixtures,
    dir: 'providers/xai/conformance'
  }
] as const

describe('record-responses-fixtures arguments', () => {
  it('needs a family and defaults to a dry run with the family default models', () => {
    expect(() => parseProbeArgs([])).toThrow(familyRequiredMessage)
    expect(() => parseProbeArgs(['--family', 'gemini'])).toThrow('Unknown family')
    expect(parseProbeArgs(['--family', 'codex'])).toEqual(codexOptions)
    expect(parseProbeArgs(['--family=grok'])).toEqual(grokOptions)
    expect(parseProbeArgs(['--help']).help).toBe(true)
    expect(probeModels(codexOptions)).toEqual(openAiCodexConformanceDefaultModels)
    expect(probeModels(grokOptions)).toEqual(xAiGrokConformanceDefaultModels)
    expect(responsesFamilies.codex.tokenEnv).toBe('OPENAI_CODEX_ACCESS_TOKEN')
    expect(responsesFamilies.codex.accountIdEnv).toBe('OPENAI_CODEX_ACCOUNT_ID')
    expect(responsesFamilies.grok.tokenEnv).toBe('XAI_GROK_ACCESS_TOKEN')
  })

  it('requires owner approval, an account label, and (Grok) a client version with --live', () => {
    expect(() => parseProbeArgs(['--family', 'codex', '--live'])).toThrow(
      ownerApprovalRequiredMessage
    )
    expect(() => parseProbeArgs(['--family', 'codex', '--live', '--owner-approved'])).toThrow(
      liveAccountRequiredMessage
    )
    expect(
      parseProbeArgs(['--family', 'codex', '--live', '--owner-approved', '--account', 'synthetic'])
    ).toMatchObject({ live: true, ownerApproved: true, account: 'synthetic' })
    expect(() =>
      parseProbeArgs(['--family', 'grok', '--live', '--owner-approved', '--account=synthetic'])
    ).toThrow(clientVersionRequiredMessage)
    expect(
      parseProbeArgs([
        '--family',
        'grok',
        '--live',
        '--owner-approved',
        '--account=synthetic',
        '--client-version',
        '1.2.3-host'
      ])
    ).toMatchObject({ clientVersion: '1.2.3-host' })
  })

  it('refuses --live whenever CI is set to a non-empty value', () => {
    const live = ['--family', 'codex', '--live', '--owner-approved', '--account', 'synthetic']

    for (const CI of ['true', '1', 'yes', '0', 'false', 'FALSE', ' ']) {
      expect(() => parseProbeArgs(live, { CI })).toThrow(liveInCiMessage)
      expect(isCiEnvironment({ CI })).toBe(true)
    }

    for (const CI of [undefined, '']) {
      expect(parseProbeArgs(live, { CI }).live).toBe(true)
    }

    expect(parseProbeArgs(['--family', 'codex'], { CI: 'true' }).live).toBe(false)
    expect(isCiEnvironment({ CI: 'true' })).toBe(true)
    expect(isCiEnvironment({})).toBe(false)
  })

  it('overrides models and the output limit, and rejects bad input', () => {
    const options = parseProbeArgs([
      '--family=grok',
      '--plain-model',
      'example-plain',
      '--tool-model=example-tools',
      '--invalid-model=example-missing',
      '--max-output-tokens=32'
    ])

    expect(probeModels(options)).toEqual({
      plainText: 'example-plain',
      toolCall: 'example-tools',
      invalid: 'example-missing'
    })
    expect(options.maxOutputTokens).toBe(32)
    expect(() => parseProbeArgs(['--family=codex', '--nope'])).toThrow('Unknown argument')
    expect(() => parseProbeArgs(['--family=codex', '--tool-model'])).toThrow('requires a value')
    expect(() => parseProbeArgs(['--family=grok', '--max-output-tokens=0'])).toThrow(
      'positive integer'
    )
  })
})

describe('record-responses-fixtures plan', () => {
  it('maps every conformance case to its existing fixture file and export', () => {
    for (const family of families) {
      const plan = planResponsesProbe(family.options)

      expect(plan.map(entry => entry.caseId)).toEqual(family.cases.map(testCase => testCase.id))
      expect(plan.map(entry => entry.fixtureModule.exportName)).toEqual(
        family.fixtures.map(fixture =>
          family.family === 'codex'
            ? `openAiCodex${exportSuffix(fixture.caseId)}Fixture`
            : `xAiGrok${exportSuffix(fixture.caseId)}Fixture`
        )
      )
      expect(plan.map(entry => entry.model)).toEqual(family.fixtures.map(fixture => fixture.model))
    }

    expect(responsesFixtureModuleFor('codex', 'openai.codex.stream.terminal-event')?.fileName).toBe(
      'codex-terminal-event.ts'
    )
    expect(responsesFixtureModuleFor('grok', 'xai.grok.stream.terminal-event')?.fileName).toBe(
      'terminal-event.ts'
    )
  })

  it('dry-runs every case id with its endpoint, token variable, and the approval note', () => {
    for (const family of families) {
      const report = dryRunReport(family.options)
      const spec = responsesFamilies[family.family]

      expect(report).toContain('DRY RUN: no network request was made')
      expect(report).toContain(spec.endpoint)
      expect(report).toContain(spec.tokenEnv)
      expect(report).toContain("need the repository owner's explicit approval")

      for (const testCase of family.cases) {
        expect(report).toContain(testCase.id)
      }
    }

    expect(defaultProbeOptions.maxOutputTokens).toBe(512)
    expect(dryRunReport(grokOptions)).toContain(
      'Grok cases send max_output_tokens 512; raise it with --max-output-tokens <n>'
    )
    expect(dryRunReport(codexOptions)).not.toContain('max_output_tokens')
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const fixtureModule = responsesFixtureModuleFor('grok', xAiGrokPlainTextFixture.caseId)

    if (fixtureModule === undefined) {
      expect.fail('missing plain-text module')
    }

    const source = renderFixtureModule(grokOptions, fixtureModule, xAiGrokPlainTextFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const xAiGrokPlainTextFixture: WireFixture = {')
    expect(source).toContain(
      '`pnpm conformance:grok --live --owner-approved --account <label> --client-version <version>`'
    )

    const codexModule = responsesFixtureModuleFor('codex', openAiCodexPlainTextFixture.caseId)

    if (codexModule === undefined) {
      expect.fail('missing Codex plain-text module')
    }

    const codexSource = renderFixtureModule(codexOptions, codexModule, openAiCodexPlainTextFixture)

    expect(codexSource).toContain(
      '`pnpm conformance:codex --live --owner-approved --account <label>`'
    )
    expect(codexSource).not.toContain('--client-version')
  })
})

const exportSuffix = (caseId: string) =>
  (caseId.split('.').at(-1) ?? '')
    .split('-')
    .map(word => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join('')

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

/** The committed Codex plain-text stream with account-derived fields added to response.created. */
const withIdentifiers = (): WireExchange => {
  const [exchange] = openAiCodexPlainTextFixture.exchanges
  const chunks = streamChunks(exchange)

  return withChunks(
    exchange,
    chunks.map(chunk =>
      Predicate.isString(chunk) && chunk.startsWith('event: response.created')
        ? chunk.replace(
            '"metadata":{}',
            '"metadata":{},"safety_identifier":"synthetic-safety-id","prompt_cache_key":"synthetic-cache-key","user":"synthetic-user"'
          )
        : chunk
    )
  )
}

const identifierChunkIndex = (chunks: ReadonlyArray<WireChunk>) =>
  chunks.findIndex(chunk => Predicate.isString(chunk) && chunk.includes('synthetic-safety-id'))

/** The committed Codex plain-text stream with `members` spliced into response.created. */
const withCreatedMembers = (members: string): WireExchange => {
  const [exchange] = openAiCodexPlainTextFixture.exchanges

  return withChunks(
    exchange,
    streamChunks(exchange).map(chunk =>
      Predicate.isString(chunk) && chunk.startsWith('event: response.created')
        ? chunk.replace('"metadata":{}', `"metadata":{},${members}`)
        : chunk
    )
  )
}

/**
 * A response.created carrying `"user"` twice: a real value first, then the placeholder. The chunk
 * is cut inside the first value, so chunk-by-chunk redaction cannot rewrite it, while
 * `JSON.parse` of the reassembled payload keeps only the trailing placeholder.
 */
const withSplitDuplicateUser = (): WireExchange => {
  const exchange = withCreatedMembers(
    `"user":"synthetic-private-user","user":"${responsesRedactedValue}"`
  )

  const chunks = streamChunks(exchange)

  const index = chunks.findIndex(
    chunk => Predicate.isString(chunk) && chunk.includes('synthetic-private-user')
  )

  const chunk = chunks[index]

  if (!Predicate.isString(chunk)) {
    return expect.fail('no duplicate-user chunk')
  }

  const cut = chunk.indexOf('synthetic-private-user') + 'synthetic'.length

  return withChunks(exchange, [
    ...chunks.slice(0, index),
    chunk.slice(0, cut),
    chunk.slice(cut),
    ...chunks.slice(index + 1)
  ])
}

/**
 * A response.created carrying `"us\u0065r"` (an escaped `user`, which chunk redaction never sees)
 * plus a member nested past the scanner's depth limit, so the payload cannot be member-scanned.
 */
const withEscapedUserBehindDeepNesting = (): WireExchange =>
  withCreatedMembers(
    `${String.raw`"us\u0065r":"synthetic-private-user"`},"deep":${'['.repeat(300)}${']'.repeat(300)}`
  )

/** The committed Codex plain-text stream plus an invalid-JSON event naming a redacted field. */
const withInvalidPayload = (): WireExchange => {
  const [exchange] = openAiCodexPlainTextFixture.exchanges

  return withChunks(exchange, [
    ...streamChunks(exchange),
    'event: response.created\ndata: {"safety_identifier": synthetic-private-id, "user"\n\n'
  ])
}

/** The reassembled text `data:` payload of the response.created event. */
const createdPayload = (exchange: WireExchange): string =>
  streamChunks(exchange)
    .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
    .join('')
    .split('\n\n')
    .flatMap(block => (block.startsWith('event: response.created') ? block.split('\n') : []))
    .find(line => line.startsWith('data: '))
    ?.slice('data: '.length) ?? expect.fail('no response.created payload')

describe('record-responses-fixtures redaction', () => {
  it('redacts account-derived and encrypted fields chunk by chunk, keeping every boundary', () => {
    const exchange = withIdentifiers()
    const redacted = redactResponsesFields(exchange)

    expect(unredactedResponsesFields([exchange])).toEqual([
      'safety_identifier',
      'prompt_cache_key',
      'user'
    ])
    expect(unredactedResponsesFields([redacted])).toEqual([])
    expect(streamChunks(redacted)).toHaveLength(streamChunks(exchange).length)
    expect(JSON.stringify(redacted)).not.toContain('synthetic-safety-id')
    expect(streamChunks(redacted).join('')).toContain(`"user":"${responsesRedactedValue}"`)
    // Idempotent: a redacted recording is returned as is.
    expect(redactResponsesFields(redacted)).toBe(redacted)
  })

  it('leaves the committed recordings untouched', () => {
    for (const fixture of [...openAiCodexConformanceFixtures, ...xAiGrokConformanceFixtures]) {
      const [exchange] = fixture.exchanges

      expect(redactResponsesFields(exchange), fixture.id).toBe(exchange)
      expect(unredactedResponsesFields([exchange]), fixture.id).toEqual([])
    }
  })

  it('redacts encrypted reasoning content in a JSON body', () => {
    const exchange: WireExchange = {
      request: openAiCodexPlainTextFixture.exchanges[0].request,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          output: [{ type: 'reasoning', encrypted_content: 'synthetic-encrypted', summary: [] }]
        })
      }
    }

    const redacted = redactResponsesFields(exchange)

    expect(unredactedResponsesFields([exchange])).toEqual(['encrypted_content'])
    expect(unredactedResponsesFields([redacted])).toEqual([])
    expect(JSON.stringify(redacted)).not.toContain('synthetic-encrypted')
  })

  it('never rewrites a base64 chunk or a value split across chunks, and reports both', () => {
    const exchange = withIdentifiers()
    const chunks = streamChunks(exchange)
    const index = identifierChunkIndex(chunks)
    const chunk = chunks[index]

    if (!Predicate.isString(chunk)) {
      return expect.fail('no identifier chunk')
    }

    const base64 = withChunks(exchange, [
      ...chunks.slice(0, index),
      { base64: Buffer.from(chunk, 'utf8').toString('base64') },
      ...chunks.slice(index + 1)
    ])

    const cut = chunk.indexOf('synthetic-safety-id') + 'synthetic'.length

    const split = withChunks(exchange, [
      ...chunks.slice(0, index),
      chunk.slice(0, cut),
      chunk.slice(cut),
      ...chunks.slice(index + 1)
    ])

    expect(streamChunks(redactResponsesFields(base64))).toEqual(streamChunks(base64))
    expect(unredactedResponsesFields([redactResponsesFields(base64)])).toEqual([
      'safety_identifier',
      'prompt_cache_key',
      'user'
    ])
    expect(unredactedResponsesFields([redactResponsesFields(split)])).toContain('safety_identifier')
  })

  it('refuses a repeated redacted key whose first value crossed a chunk boundary', () => {
    const redacted = redactResponsesFields(withSplitDuplicateUser())
    const payload = createdPayload(redacted)

    // The first value survives on the wire, yet JSON.parse only keeps the trailing placeholder.
    expect(payload).toContain('"user":"synthetic-private-user"')
    expect(JSON.parse(payload)).toMatchObject({ response: { user: responsesRedactedValue } })
    expect(unredactedResponsesFields([redacted])).toEqual(['user'])
  })

  it('refuses a repeated redacted key even when every value is the placeholder', () => {
    const placeholder = JSON.stringify(responsesRedactedValue)

    expect(
      unredactedResponsesFields([withCreatedMembers(`"user":${placeholder},"user":${placeholder}`)])
    ).toEqual(['user'])
  })

  it('refuses non-string values of redacted fields and allows null and the placeholder', () => {
    const nonStrings = withCreatedMembers(
      '"safety_identifier":12345,"prompt_cache_key":{"id":"synthetic"},"user":["synthetic"],"encrypted_content":true'
    )

    expect(unredactedResponsesFields([redactResponsesFields(nonStrings)])).toEqual([
      'encrypted_content',
      'safety_identifier',
      'prompt_cache_key',
      'user'
    ])

    const allowed = withCreatedMembers(
      `"safety_identifier":null,"prompt_cache_key":"","user":${JSON.stringify(responsesRedactedValue)}`
    )

    expect(unredactedResponsesFields([allowed])).toEqual([])
  })

  it('sees a redacted key written with JSON escapes', () => {
    const escaped = withCreatedMembers(String.raw`"us\u0065r":"synthetic-private-user"`)

    expect(redactResponsesFields(escaped)).toBe(escaped)
    expect(unredactedResponsesFields([escaped])).toEqual(['user'])
  })

  it('refuses a payload that is not JSON, never falling back to a textual check', () => {
    const broken = withInvalidPayload()

    expect(unredactedResponsesFields([broken])).toEqual([])
    expect(unscannableResponsesPayloads([broken])).toBe(1)
    expect(responsesRedactionRefusal([broken])).toContain('could not check 1 response payload')
  })

  it('refuses a payload nested past the scanner depth limit, whatever its keys', () => {
    const nested = withEscapedUserBehindDeepNesting()

    // JSON.parse reads it fine and finds the escaped `user`; the scanner stops at its depth limit.
    expect(JSON.parse(createdPayload(nested))).toMatchObject({
      response: { user: 'synthetic-private-user' }
    })
    expect(redactResponsesFields(nested)).toBe(nested)
    expect(unscannableResponsesPayloads([nested])).toBe(1)
    expect(responsesRedactionRefusal([nested])).toContain('could not check 1 response payload')
  })

  it('lets only the permitted non-JSON sentinels through', () => {
    const [exchange] = openAiCodexPlainTextFixture.exchanges

    const done = withChunks(exchange, [...streamChunks(exchange), 'data: [DONE]\n\n'])

    expect(responsesPermittedNonJsonPayloads).toEqual(['[DONE]'])
    expect(unscannableResponsesPayloads([done])).toBe(0)
    expect(responsesRedactionRefusal([done])).toBeUndefined()

    for (const payload of ['[done]', 'DONE', '[DONE] trailing', 'ping']) {
      const other = withChunks(exchange, [...streamChunks(exchange), `data: ${payload}\n\n`])

      expect(unscannableResponsesPayloads([other]), payload).toBe(1)
    }
  })
})

type SsePayload = { readonly event: string | undefined; readonly json: unknown }

/**
 * The SSE events of a recorded stream: every chunk (text and `{ base64 }`) reassembled, split into
 * events, and each `data:` payload parsed, so edits never depend on chunk boundaries or spacing.
 */
const ssePayloads = (exchange: WireExchange): Array<SsePayload> =>
  streamChunks(exchange)
    .map(chunk =>
      Predicate.isString(chunk) ? chunk : Buffer.from(chunk.base64, 'base64').toString('utf8')
    )
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .flatMap(block => {
      const lines = block.split('\n')

      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      const event = lines
        .find(line => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim()

      return data.length === 0 ? [] : [{ event, json: JSON.parse(data) }]
    })

/** One text chunk per event, re-serialized from the parsed payloads. */
const sseChunks = (payloads: ReadonlyArray<SsePayload>): Array<WireChunk> =>
  payloads.map(
    ({ event, json }) =>
      `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(json)}\n\n`
  )

type Json = null | boolean | number | string | Array<Json> | MutableJson

type MutableJson = { [key: string]: Json }

const isJsonObject = (value: unknown): value is MutableJson =>
  Predicate.isObject(value) && !Array.isArray(value)

const visitObjects = (value: unknown, visit: (record: MutableJson) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visit)

    return
  }

  if (!isJsonObject(value)) return

  visit(value)

  for (const item of Object.values(value)) visitObjects(item, visit)
}

/**
 * Rename the tool argument in every function-call argument field, structurally: the first
 * `response.function_call_arguments.delta` of each item carries `{"town":...}` (later deltas are
 * emptied), and `response.function_call_arguments.done` and every completed `function_call` item
 * carry the same text, so the stream stays self-consistent but lacks the claimed `city`. Returns
 * how many fields changed.
 */
const withoutCityArgument = (fixture: WireFixture) => {
  const [exchange] = fixture.exchanges
  const renamed = JSON.stringify({ town: 'Springfield' })
  const seenItems = new Set<unknown>()
  let changed = 0

  const set = (record: MutableJson, key: string, value: string) => {
    if (record[key] !== value) changed++

    record[key] = value
  }

  const payloads = ssePayloads(exchange).map(({ event, json }) => {
    const edited: unknown = structuredClone(json)

    visitObjects(edited, record => {
      if (record.type === 'response.function_call_arguments.delta') {
        set(record, 'delta', seenItems.has(record.item_id) ? '' : renamed)
        seenItems.add(record.item_id)
      }

      if (record.type === 'response.function_call_arguments.done') set(record, 'arguments', renamed)

      if (record.type === 'function_call' && Predicate.isString(record.arguments)) {
        set(record, 'arguments', record.status === 'in_progress' ? '' : renamed)
      }
    })

    return { event, json: edited }
  })

  const edited: WireFixture = {
    ...fixture,
    exchanges: [withChunks(exchange, sseChunks(payloads))]
  }

  return { fixture: edited, changed }
}

const tampered = () => {
  const edit = withoutCityArgument(openAiCodexFunctionCallArgumentsFixture)

  // A no-op edit would make every drill below vacuous.
  expect(edit.changed).toBeGreaterThan(0)

  return openAiCodexConformanceFixtures.map(fixture =>
    fixture.id === openAiCodexFunctionCallArgumentsFixture.id ? edit.fixture : fixture
  )
}

describe('record-responses-fixtures replay verification', () => {
  it('passes every case of both families against the committed fixtures', async () => {
    for (const family of families) {
      const report = await Effect.runPromise(
        verifyResponsesFixtures(family.fixtures, family.options)
      )

      expect(conformanceReportFailed(report)).toBe(false)
      expect(report.summary).toEqual({ passed: family.cases.length, failed: 0, skipped: 0 })
      expect(casesWithoutSingleFixture(family.fixtures, family.options)).toEqual([])
    }
  })

  it('fails the report for a tampered recording, so it would not be written', async () => {
    const report = await Effect.runPromise(verifyResponsesFixtures(tampered(), codexOptions))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results[1]).toMatchObject({
      id: 'openai.codex.stream.function-call-arguments',
      status: 'failed',
      failure: { message: 'expected a non-empty string `city` argument' }
    })
  })

  it('fails the report when a case has no recording', async () => {
    const missing = xAiGrokConformanceFixtures.filter(
      fixture => fixture.id !== xAiGrokPlainTextFixture.id
    )

    const report = await Effect.runPromise(verifyResponsesFixtures(missing, grokOptions))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results[0]).toMatchObject({ id: 'xai.grok.stream.plain-text', status: 'failed' })
    expect(casesWithoutSingleFixture(missing, grokOptions)).toEqual(['xai.grok.stream.plain-text'])
  })
})

describe('record-responses-fixtures write gate', () => {
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
    options: ProbeOptions,
    fixtures: ReadonlyArray<WireFixture>
  ): ReadonlyArray<RecordedResponsesFixture> =>
    planResponsesProbe(options).flatMap(entry =>
      fixtures.flatMap(fixture => (fixture.caseId === entry.caseId ? [{ entry, fixture }] : []))
    )

  it('writes every fixture module, then formats them, only after replay verification passes', async () => {
    for (const family of families) {
      const { calls, writer } = recordingWriter()

      const result = await Effect.runPromise(
        writeVerifiedFixtures(recordedFrom(family.options, family.fixtures), family.options, writer)
      )

      expect(conformanceReportFailed(result.report)).toBe(false)
      expect(result.files.map(file => basename(file))).toEqual(
        planResponsesProbe(family.options).map(entry => entry.fixtureModule.fileName)
      )
      expect(result.files.every(file => file.includes(family.dir))).toBe(true)
      expect(calls).toEqual([
        ...result.files.map(file => ({ kind: 'write', paths: [file] })),
        { kind: 'format', paths: result.files }
      ])
    }
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { calls, writer } = recordingWriter()

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(codexOptions, tampered()), codexOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'no fixture was written'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a redacted field survives in a base64 chunk', async () => {
    const { calls, writer } = recordingWriter()
    const exchange = withIdentifiers()
    const chunks = streamChunks(exchange)
    const index = identifierChunkIndex(chunks)
    const chunk = chunks[index]

    const recording = withChunks(exchange, [
      ...chunks.slice(0, index),
      { base64: Buffer.from(Predicate.isString(chunk) ? chunk : '', 'utf8').toString('base64') },
      ...chunks.slice(index + 1)
    ])

    const fixtures = openAiCodexConformanceFixtures.map((fixture): WireFixture =>
      fixture.id === openAiCodexPlainTextFixture.id
        ? { ...fixture, exchanges: [recording] }
        : fixture
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(codexOptions, fixtures), codexOptions, writer)
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not redact safety_identifier'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a repeated redacted key hides a value split across chunks', async () => {
    const { calls, writer } = recordingWriter()
    const recording = redactResponsesFields(withSplitDuplicateUser())

    const fixtures = openAiCodexConformanceFixtures.map((fixture): WireFixture =>
      fixture.id === openAiCodexPlainTextFixture.id
        ? { ...fixture, exchanges: [recording] }
        : fixture
    )

    // Replay alone would pass: the provider never reads `user`.
    const report = await Effect.runPromise(verifyResponsesFixtures(fixtures, codexOptions))

    expect(conformanceReportFailed(report)).toBe(false)

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(codexOptions, fixtures), codexOptions, writer)
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not redact user'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when an escaped redacted key hides behind nesting past the depth limit', async () => {
    const { calls, writer } = recordingWriter()
    const recording = redactResponsesFields(withEscapedUserBehindDeepNesting())

    const fixtures = openAiCodexConformanceFixtures.map((fixture): WireFixture =>
      fixture.id === openAiCodexPlainTextFixture.id
        ? { ...fixture, exchanges: [recording] }
        : fixture
    )

    // Replay alone would pass: the provider never reads `user` or `deep`.
    const report = await Effect.runPromise(verifyResponsesFixtures(fixtures, codexOptions))

    expect(conformanceReportFailed(report)).toBe(false)

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(codexOptions, fixtures), codexOptions, writer)
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not check 1 response payload'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when an invalid JSON payload names a redacted field', async () => {
    const { calls, writer } = recordingWriter()
    const recording = redactResponsesFields(withInvalidPayload())

    const fixtures = openAiCodexConformanceFixtures.map((fixture): WireFixture =>
      fixture.id === openAiCodexPlainTextFixture.id
        ? { ...fixture, exchanges: [recording] }
        : fixture
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(codexOptions, fixtures), codexOptions, writer)
    )

    expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')).toContain(
      'could not check 1 response payload'
    )
    expect(calls).toEqual([])
  })

  it('writes nothing when a case has no recording', async () => {
    const { calls, writer } = recordingWriter()

    const missing = xAiGrokConformanceFixtures.filter(
      fixture => fixture.id !== xAiGrokPlainTextFixture.id
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(grokOptions, missing), grokOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })
})

const runCli = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, probeScript, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: '',
          OPENAI_CODEX_ACCESS_TOKEN: '',
          OPENAI_CODEX_ACCOUNT_ID: '',
          XAI_GROK_ACCESS_TOKEN: '',
          ...env
        }
      },
      (error, stdout, stderr) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

describe('record-responses-fixtures CLI', () => {
  it('dry-runs each family by default without needing a token', async () => {
    for (const family of families) {
      const result = await runCli(['--family', family.family])

      expect(result.failed).toBe(false)
      expect(result.stdout).toContain('DRY RUN: no network request was made')

      for (const testCase of family.cases) {
        expect(result.stdout).toContain(testCase.id)
      }
    }
  })

  it('refuses --live without owner approval before reading any credential', async () => {
    const result = await runCli(['--family', 'codex', '--live', '--account', 'synthetic'])

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('--live requires --owner-approved')
  })

  it('refuses --live in CI, even when approved and given a token', async () => {
    const result = await runCli(
      ['--family', 'codex', '--live', '--owner-approved', '--account', 'synthetic'],
      { CI: 'true', OPENAI_CODEX_ACCESS_TOKEN: 'synthetic-not-a-token' }
    )

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)

    // A dry run is still fine in CI.
    const dryRun = await runCli(['--family', 'codex'], { CI: 'true' })

    expect(dryRun.failed).toBe(false)
    expect(dryRun.stdout).toContain('DRY RUN: no network request was made')
  })

  it('refuses an approved live run without the token, before any network call', async () => {
    const result = await runCli([
      '--family',
      'codex',
      '--live',
      '--owner-approved',
      '--account',
      'synthetic'
    ])

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('OPENAI_CODEX_ACCESS_TOKEN is required for --live')
  })
})
