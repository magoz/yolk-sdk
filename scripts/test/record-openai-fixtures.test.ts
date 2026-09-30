import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  openAiChatPlainTextFixture,
  openAiChatToolCallDeltasFixture,
  openAiConformanceCases,
  openAiConformanceDefaultModels,
  openAiConformanceFixtures
} from '../../packages/agent/src/providers/openai/conformance/index.ts'
import {
  isWireStreamResponse,
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import {
  casesWithoutSingleFixture,
  defaultProbeOptions,
  dryRunReport,
  openAiApiKeyEnv,
  liveAccountRequiredMessage,
  liveInCiMessage,
  ownerApprovalRequiredMessage,
  openAiFixtureModuleFor,
  openAiFixtureModules,
  parseProbeArgs,
  planOpenAiProbe,
  renderFixtureModule,
  runLive,
  verifyOpenAiFixtures,
  writeVerifiedFixtures,
  type FixtureWriter,
  type LiveProbeIo,
  type ProbeOptions,
  type RecordedOpenAiFixture
} from '../record-openai-fixtures.ts'
import type { ProbeEnv } from '../fixture-probe-internal.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-openai-fixtures.ts')

const caseIds = openAiConformanceCases.map(testCase => testCase.id)

describe('record-openai-fixtures arguments', () => {
  it('defaults to a dry run with the conformance default models and no account label', () => {
    expect(parseProbeArgs([])).toEqual(defaultProbeOptions)
    expect(defaultProbeOptions).toMatchObject({
      live: false,
      account: undefined,
      models: openAiConformanceDefaultModels,
      maxTokens: 64
    })
  })

  it('requires an explicit --account label with --live', () => {
    expect(() => parseProbeArgs(['--live', '--owner-approved'])).toThrow(liveAccountRequiredMessage)
    expect(() =>
      parseProbeArgs(['--live', '--owner-approved', '--plain-model', 'example-plain'])
    ).toThrow('--live requires --account <label>')
    expect(parseProbeArgs(['--live', '--owner-approved', '--account', 'synthetic'])).toMatchObject({
      live: true,
      ownerApproved: true,
      account: 'synthetic'
    })
    expect(parseProbeArgs(['--account=synthetic']).live).toBe(false)
    expect(parseProbeArgs(['--live', '--help']).help).toBe(true)
  })

  it('overrides each model and the limit in both --flag value and --flag=value forms', () => {
    expect(
      parseProbeArgs([
        '--live',
        '--plain-model',
        'example-plain',
        '--tool-model=example-tools',
        '--invalid-model=example-missing',
        '--max-tokens',
        '32',
        '--account=synthetic',
        '--owner-approved'
      ])
    ).toEqual({
      live: true,
      help: false,
      ownerApproved: true,
      models: {
        plainText: 'example-plain',
        toolCall: 'example-tools',
        invalid: 'example-missing'
      },
      maxTokens: 32,
      account: 'synthetic'
    })
    expect(defaultProbeOptions.models).toEqual(openAiConformanceDefaultModels)
  })

  it('rejects unknown flags, missing values, invalid numbers, and reasoning flags', () => {
    expect(() => parseProbeArgs(['--nope'])).toThrow('Unknown argument')
    expect(() => parseProbeArgs(['--tool-model'])).toThrow('requires a value')
    expect(() => parseProbeArgs(['--max-tokens=0'])).toThrow('positive integer')
    expect(() => parseProbeArgs(['--reasoning-effort=high'])).toThrow('Unknown argument')
  })
})

describe('record-openai-fixtures owner-approval and CI gates', () => {
  const liveArgs = ['--live', '--owner-approved', '--account', 'synthetic']

  it('refuses --live without --owner-approved', () => {
    expect(() => parseProbeArgs(['--live', '--account', 'synthetic'])).toThrow(
      ownerApprovalRequiredMessage
    )
    expect(() => parseProbeArgs(['--live'])).toThrow(ownerApprovalRequiredMessage)
    expect(ownerApprovalRequiredMessage).toContain('--live requires --owner-approved')
  })

  it('refuses --live whenever CI is non-empty, CI=0 and CI=false included', () => {
    for (const CI of ['1', '0', 'false', 'true']) {
      expect(() => parseProbeArgs(liveArgs, { CI })).toThrow(liveInCiMessage)
      // The CI refusal comes first, whatever else is missing.
      expect(() => parseProbeArgs(['--live'], { CI })).toThrow(liveInCiMessage)
    }

    expect(parseProbeArgs(liveArgs, {})).toMatchObject({ live: true, ownerApproved: true })
    expect(parseProbeArgs(liveArgs, { CI: '' }).live).toBe(true)
  })

  it('dry-runs without --owner-approved or --account, even in CI', () => {
    for (const CI of ['1', '0', 'false']) {
      expect(parseProbeArgs([], { CI })).toEqual(defaultProbeOptions)
      expect(parseProbeArgs(['--account=synthetic'], { CI }).live).toBe(false)
    }

    expect(parseProbeArgs(['--live', '--help'], { CI: '1' }).help).toBe(true)
    expect(dryRunReport(defaultProbeOptions)).toContain(
      'no credential was read. Pass --live --owner-approved --account <label> to record'
    )
  })
})

describe('record-openai-fixtures live gates', () => {
  const approved: ProbeOptions = {
    ...defaultProbeOptions,
    live: true,
    ownerApproved: true,
    account: 'synthetic'
  }

  // Credential reads and writes are recorded and fail the run, so a gate that did not refuse first
  // shows up both in `reads` and in the failure message.
  const guardedIo = (env: ProbeEnv, credential?: string) => {
    const reads: Array<string> = []

    const io: LiveProbeIo = {
      env,
      readCredential: name => {
        reads.push(name)

        if (credential === undefined) throw new Error(`credential $openai was read`)

        return credential
      },
      writer: {
        writeFile: path => {
          throw new Error(`wrote ${path}`)
        },
        formatFiles: paths => {
          throw new Error(`formatted ${paths.join(', ')}`)
        }
      }
    }

    return { reads, io }
  }

  const failureOf = async (options: ProbeOptions, io: LiveProbeIo): Promise<string> => {
    const exit = await Effect.runPromiseExit(runLive(options, io))

    return Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : 'the live run succeeded'
  }

  it('refuses a live run without owner approval before reading any credential', async () => {
    const { reads, io } = guardedIo({})

    expect(await failureOf({ ...approved, ownerApproved: false }, io)).toContain(
      ownerApprovalRequiredMessage
    )
    expect(reads).toEqual([])
  })

  it('refuses a live run when CI is 1, 0, or false before reading any credential', async () => {
    for (const CI of ['1', '0', 'false']) {
      const { reads, io } = guardedIo({ CI })

      expect(await failureOf(approved, io)).toContain(liveInCiMessage)
      expect(reads).toEqual([])
    }
  })

  it('refuses a live run without an account label before reading any credential', async () => {
    const { reads, io } = guardedIo({ CI: '' })

    expect(await failureOf({ ...approved, account: undefined }, io)).toContain(
      liveAccountRequiredMessage
    )
    expect(reads).toEqual([])
  })

  it('reads the credential only after every gate passes (an empty one stops the run)', async () => {
    const { reads, io } = guardedIo({ CI: '' }, '')

    expect(await failureOf(approved, io)).toContain(`${openAiApiKeyEnv} is required for --live`)
    expect(reads).toEqual([openAiApiKeyEnv])
    expect(openAiApiKeyEnv).toBe('OPENAI_API_KEY')
  })
})

describe('record-openai-fixtures plan', () => {
  it('maps every conformance case to its existing fixture file and export', () => {
    expect(caseIds).toEqual(openAiFixtureModules.map(fixtureModule => fixtureModule.caseId))
    expect(
      caseIds.map(caseId => {
        const fixtureModule = openAiFixtureModuleFor(caseId)

        return [caseId, fixtureModule?.fileName, fixtureModule?.exportName]
      })
    ).toEqual([
      ['openai.chat.stream.plain-text', 'plain-text.ts', 'openAiChatPlainTextFixture'],
      [
        'openai.chat.stream.tool-call-deltas',
        'tool-call-deltas.ts',
        'openAiChatToolCallDeltasFixture'
      ],
      ['openai.chat.stream.error-envelope', 'error-envelope.ts', 'openAiChatErrorEnvelopeFixture'],
      ['openai.chat.json.plain-text', 'json-plain-text.ts', 'openAiChatJsonPlainTextFixture']
    ])
    expect(openAiConformanceFixtures.map(fixture => fixture.caseId)).toEqual(caseIds)
  })

  it('plans each case with its model and token limit', () => {
    const models = openAiConformanceDefaultModels

    expect(
      planOpenAiProbe(defaultProbeOptions).map(entry => [
        entry.testCase.id,
        entry.testCase.safety,
        entry.model,
        entry.maxTokens
      ])
    ).toEqual([
      ['openai.chat.stream.plain-text', 'read', models.plainText, 64],
      ['openai.chat.stream.tool-call-deltas', 'read', models.toolCall, 64],
      ['openai.chat.stream.error-envelope', 'read', models.invalid, 64],
      ['openai.chat.json.plain-text', 'read', models.plainText, 64]
    ])
  })

  it('dry-runs every case id with the default models', () => {
    const report = dryRunReport(defaultProbeOptions)

    expect(report).toContain('DRY RUN: no network request was made')
    expect(report).toContain('Endpoint: https://api.openai.com/v1/chat/completions')

    for (const caseId of caseIds) {
      expect(report).toContain(`- ${caseId} [read]`)
    }

    for (const model of Object.values(openAiConformanceDefaultModels)) {
      expect(report).toContain(`model ${model}`)
    }
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const fixtureModule = openAiFixtureModuleFor(openAiChatPlainTextFixture.caseId)

    if (fixtureModule === undefined) {
      expect.fail('missing plain-text module')
    }

    const source = renderFixtureModule(fixtureModule, openAiChatPlainTextFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const openAiChatPlainTextFixture: WireFixture = {')
    expect(source).toContain(
      'Regenerate with\n * `pnpm conformance:openai --live --owner-approved --account <label>`.'
    )
  })
})

// Strip `tool_calls` from every parsed SSE `data:` payload: a recording the tool-call case must
// reject. Structural, so it holds for any recorded text and any fragment split.
const stripToolCallsFromEvent = (event: string): string => {
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
      Reflect.deleteProperty(choice.delta, 'tool_calls')
    }
  }

  return `data: ${JSON.stringify(json)}\n\n`
}

const exchangeWithoutToolCalls = (exchange: WireExchange): WireExchange => {
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
        .map(stripToolCallsFromEvent)
    }
  }
}

const withoutToolCalls = (fixture: WireFixture): WireFixture => {
  const [first, ...rest] = structuredClone(fixture.exchanges)

  return {
    ...fixture,
    exchanges: [exchangeWithoutToolCalls(first), ...rest.map(exchangeWithoutToolCalls)]
  }
}

const tampered = () =>
  openAiConformanceFixtures.map(fixture =>
    fixture.id === openAiChatToolCallDeltasFixture.id ? withoutToolCalls(fixture) : fixture
  )

describe('record-openai-fixtures replay verification', () => {
  it('passes every case against the committed fixtures', async () => {
    const report = await Effect.runPromise(verifyOpenAiFixtures(openAiConformanceFixtures))

    expect(conformanceReportFailed(report)).toBe(false)
    expect(report.target).toEqual({ kind: 'replay' })
    expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
    expect(casesWithoutSingleFixture(openAiConformanceFixtures)).toEqual([])
  })

  it('fails the report for a tampered recording, so it would not be written', async () => {
    const report = await Effect.runPromise(verifyOpenAiFixtures(tampered()))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results.map(result => [result.id, result.status])).toEqual(
      caseIds.map(caseId => [
        caseId,
        caseId === openAiChatToolCallDeltasFixture.caseId ? 'failed' : 'passed'
      ])
    )
    expect(report.results[1]?.failure?.message).toBe('expected exactly one assembled tool call')
  })

  it('fails the report when a case has no recording', async () => {
    const missing = openAiConformanceFixtures.filter(
      fixture => fixture.id !== openAiChatPlainTextFixture.id
    )

    const report = await Effect.runPromise(verifyOpenAiFixtures(missing))

    expect(conformanceReportFailed(report)).toBe(true)
    expect(report.results[0]).toMatchObject({
      id: 'openai.chat.stream.plain-text',
      status: 'failed'
    })
    expect(casesWithoutSingleFixture(missing)).toEqual(['openai.chat.stream.plain-text'])
  })
})

describe('record-openai-fixtures write gate', () => {
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
  ): ReadonlyArray<RecordedOpenAiFixture> =>
    planOpenAiProbe(defaultProbeOptions).flatMap(entry =>
      fixtures.flatMap(fixture =>
        fixture.caseId === entry.testCase.id ? [{ entry, fixture }] : []
      )
    )

  it('writes every fixture module, then formats them, only after replay verification passes', async () => {
    const { calls, writer } = recordingWriter()

    const result = await Effect.runPromise(
      writeVerifiedFixtures(recordedFrom(openAiConformanceFixtures), defaultProbeOptions, writer)
    )

    expect(conformanceReportFailed(result.report)).toBe(false)
    expect(result.files.map(file => basename(file))).toEqual(
      openAiFixtureModules.map(fixtureModule => fixtureModule.fileName)
    )
    expect(result.files.every(file => file.includes('providers/openai/conformance'))).toBe(true)
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

    const missing = openAiConformanceFixtures.filter(
      fixture => fixture.id !== openAiChatPlainTextFixture.id
    )

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(recordedFrom(missing), defaultProbeOptions, writer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('record-openai-fixtures CLI', () => {
  it('dry-runs by default without needing an OpenAI key', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, probeScript],
        { cwd: repoRoot, env: { ...process.env, OPENAI_API_KEY: '' } },
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

  const runProbeCli = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
    new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, probeScript, ...args],
        { cwd: repoRoot, env: { ...process.env, CI: '', OPENAI_API_KEY: '', ...env } },
        (error, stdout, stderr) => {
          resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
        }
      )
    })

  it('refuses --live without --owner-approved', async () => {
    const result = await runProbeCli(['--live', '--account', 'synthetic'], {})

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(ownerApprovalRequiredMessage)
  })

  it('refuses --live when CI is 1, 0, or false', async () => {
    for (const CI of ['1', '0', 'false']) {
      const result = await runProbeCli(['--live', '--owner-approved', '--account', 'synthetic'], {
        CI
      })

      expect(result.failed).toBe(true)
      expect(result.stderr).toContain(liveInCiMessage)
    }
  })

  it('dry-runs in CI without --owner-approved', async () => {
    const result = await runProbeCli([], { CI: '1' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain(
      'DRY RUN: no network request was made and no credential was read'
    )
  })
})
