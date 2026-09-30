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
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import {
  anthropicApiKeyEnv,
  anthropicFixtureModuleFor,
  anthropicFixtureModules,
  casesWithoutSingleFixture,
  defaultProbeOptions,
  dryRunReport,
  liveAccountRequiredMessage,
  parseProbeArgs,
  planAnthropicProbe,
  redactedSignature,
  redactThinkingSignatures,
  renderFixtureModule,
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

describe('record-anthropic-fixtures signature redaction', () => {
  const streamText = (exchange: WireExchange): string => {
    const response = exchange.response

    return isWireStreamResponse(response)
      ? response.chunks
          .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
          .join('')
      : expect.fail('not a stream')
  }

  it('replaces thinking signatures in streamed events, split across chunks or not', () => {
    const [exchange] = anthropicMessagesThinkingBeforeTextFixture.exchanges
    const text = streamText(exchange)

    // One recorded chunk, split mid-event, to show reassembly before parsing.
    const middle = Math.floor(text.length / 2)

    const split: WireExchange = {
      ...exchange,
      response: {
        status: exchange.response.status,
        headers: exchange.response.headers,
        chunks: [text.slice(0, middle), text.slice(middle)]
      }
    }

    const redacted = streamText(redactThinkingSignatures(split))

    expect(text).toContain('"signature":"synthetic-thinking-signature"')
    expect(redacted).not.toContain('synthetic-thinking-signature')
    expect(redacted).toContain(`"signature":"${redactedSignature}"`)
    // The empty signature on `content_block_start` stays as recorded.
    expect(redacted).toContain('"signature":""')
  })

  it('leaves exchanges without signatures untouched', () => {
    const [plain] = anthropicMessagesPlainTextFixture.exchanges
    const [tool] = anthropicMessagesToolUseInputDeltasFixture.exchanges

    expect(redactThinkingSignatures(plain)).toBe(plain)
    expect(redactThinkingSignatures(tool)).toBe(tool)
  })

  it('replaces signatures in a JSON message body', () => {
    const exchange: WireExchange = {
      request: anthropicMessagesPlainTextFixture.exchanges[0].request,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          content: [
            { type: 'thinking', thinking: 'Plan.', signature: 'synthetic-json-signature' },
            { type: 'text', text: 'Hello.' }
          ]
        })
      }
    }

    const redacted = redactThinkingSignatures(exchange).response

    expect('body' in redacted ? redacted.body : undefined).toContain(redactedSignature)
    expect(JSON.stringify(redacted)).not.toContain('synthetic-json-signature')
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

  // Fake live recordings: each planned case paired with a fixture, no network involved.
  const recordedFrom = (
    fixtures: ReadonlyArray<WireFixture>
  ): ReadonlyArray<RecordedAnthropicFixture> =>
    planAnthropicProbe(defaultProbeOptions).flatMap(entry =>
      fixtures.flatMap(fixture =>
        fixture.caseId === entry.testCase.id ? [{ entry, fixture }] : []
      )
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
