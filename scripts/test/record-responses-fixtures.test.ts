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
  liveAccountRequiredMessage,
  ownerApprovalRequiredMessage,
  parseProbeArgs,
  planResponsesProbe,
  probeModels,
  redactResponsesFields,
  renderFixtureModule,
  responsesFamilies,
  responsesFixtureModuleFor,
  responsesRedactedValue,
  unredactedResponsesFields,
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
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const fixtureModule = responsesFixtureModuleFor('grok', xAiGrokPlainTextFixture.caseId)

    if (fixtureModule === undefined) {
      expect.fail('missing plain-text module')
    }

    const source = renderFixtureModule(grokOptions, fixtureModule, xAiGrokPlainTextFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const xAiGrokPlainTextFixture: WireFixture = {')
    expect(source).toContain('`pnpm conformance:grok --live --owner-approved --account <label>`')
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

  it('fails closed on a payload that is not JSON but mentions a redacted field', () => {
    const [exchange] = openAiCodexPlainTextFixture.exchanges

    const broken = withChunks(exchange, [
      ...streamChunks(exchange),
      'event: response.created\ndata: {"safety_identifier": broken\n\n'
    ])

    expect(unredactedResponsesFields([broken])).toEqual(['safety_identifier'])
  })
})

/** Drop every function_call argument, so the function-call case no longer sees a city. */
const withoutArguments = (fixture: WireFixture): WireFixture => {
  const [exchange] = fixture.exchanges

  return {
    ...fixture,
    exchanges: [
      withChunks(
        exchange,
        streamChunks(exchange).map(chunk =>
          Predicate.isString(chunk)
            ? chunk.replaceAll('"arguments":"{\\"city\\":\\"Springfield\\"}"', '"arguments":"{}"')
            : chunk
        )
      )
    ]
  }
}

const tampered = () =>
  openAiCodexConformanceFixtures.map(fixture =>
    fixture.id === openAiCodexFunctionCallArgumentsFixture.id ? withoutArguments(fixture) : fixture
  )

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

const runCli = (args: ReadonlyArray<string>) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, probeScript, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENAI_CODEX_ACCESS_TOKEN: '',
          OPENAI_CODEX_ACCOUNT_ID: '',
          XAI_GROK_ACCESS_TOKEN: ''
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
