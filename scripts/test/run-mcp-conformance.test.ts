import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Option, Predicate, Result } from 'effect'
import { HttpClient, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'
import type { WireExchange, WireFixture } from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import { ReplayHttpClient, makeReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import {
  formatConformanceReport,
  runConformance,
  type ConformanceReport
} from '../../packages/conformance/src/runner.ts'
import { defineConformanceCase } from '../../packages/conformance/src/case.ts'
import {
  afloatMcpAuthRejectedFixture,
  afloatMcpConformanceFixtures,
  afloatMcpConformanceFixtureFor,
  afloatMcpConformanceFixtureSeeds,
  afloatMcpConformanceLiveSeeds,
  afloatMcpNegotiationEraFixture,
  afloatMcpToolsListFixture
} from '../../packages/connectors/src/afloat/conformance/index.ts'
import {
  defaultRunOptions,
  liveInCiMessage,
  liveInputs,
  namedLiveSecrets,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  recordingRunId,
  recordingsRootFor,
  redactingCliIo,
  redactingLiveRunIo,
  runnerLiveSecrets,
  runLive,
  stageRecordings,
  textCarriesSecret,
  textContainsAccessToken,
  withheldTokenLine,
  type CliIo,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  afloatCases,
  afloatCasePorts,
  afloatKeySecretParts,
  afloatReplayKey,
  afloatRunner,
  afloatRunnerFixtureSeeds,
  callingCaseIds,
  decodeMcpSeeds,
  figmaBlockedMessage,
  liveRunnerFor,
  mcpConformanceSeedsFor,
  missingTargetMessage,
  parseMcpTarget,
  prepareMcpRun,
  type McpRunnerSeeds
} from '../run-mcp-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-mcp-conformance.ts')

/** A synthetic key in the live format (never valid anywhere; no test sends it anywhere). */
const liveKey = `afloat_${'SyntheticLiveKey'}0000000001`

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(afloatRunner, parseMcpTarget(argv).rest, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--target', 'afloat', '--live', '--owner-approved', '--account', 'practice', ...argv])

/** An environment that records every name read, so a test can prove no credential was read. */
const watchedEnv = (values: Readonly<Record<string, string>>) => {
  const reads: Array<string> = []
  const env: Record<string, string | undefined> = {}

  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get: () => {
        reads.push(name)

        return value
      }
    })
  }

  return { env, reads }
}

const cliIo = () => {
  const out: Array<string> = []
  const err: Array<string> = []
  const codes: Array<number> = []

  return {
    io: {
      out: (line: string) => {
        out.push(line)
      },
      error: (line: string) => {
        err.push(line)
      },
      setExitCode: (code: number) => {
        codes.push(code)
      }
    },
    out,
    err,
    codes
  }
}

describe('run-mcp-conformance --target', () => {
  it('requires afloat, refuses figma (blocked) and unknown targets', () => {
    expect(parseMcpTarget(['--target', 'afloat', '--live'])).toEqual({
      target: 'afloat',
      rest: ['--live']
    })
    expect(parseMcpTarget(['--target=afloat'])).toEqual({ target: 'afloat', rest: [] })
    expect(parseMcpTarget(['--help']).rest).toEqual(['--help'])
    expect(() => parseMcpTarget([])).toThrow(missingTargetMessage)
    expect(() => parseMcpTarget(['--target', 'figma'])).toThrow(figmaBlockedMessage)
    expect(() => parseMcpTarget(['--target', 'other'])).toThrow(
      'Unknown --target: afloat is the only'
    )
    expect(() => parseMcpTarget(['--target'])).toThrow('--target requires a value')
    expect(() => parseMcpTarget(['--target', 'afloat', '--target', 'afloat'])).toThrow(
      '--target takes one target'
    )
  })
})

describe('run-mcp-conformance arguments and gates', () => {
  it('defaults to a dry run; --live needs --owner-approved and --account and is refused in CI', () => {
    expect(parse(['--target', 'afloat'])).toEqual(defaultRunOptions)

    for (const ci of ['1', 'true', 'false', '0']) {
      expect(() =>
        parse(['--target', 'afloat', '--live', '--owner-approved', '--account', 'practice'], {
          CI: ci
        })
      ).toThrow(liveInCiMessage)
    }

    expect(() => parse(['--target', 'afloat', '--live', '--account', 'practice'])).toThrow(
      ownerApprovalRequiredMessage
    )
    expect(() => parse(['--target', 'afloat', '--live', '--owner-approved'])).toThrow(
      '--live requires --account'
    )
    expect(() => parse(['--target', 'afloat', '--record'])).toThrow('--record requires --live')
    expect(() => parse(['--target', 'afloat', '--allow-irreversible', 'x'])).toThrow(
      'Unknown argument (not shown)'
    )
  })

  it('takes the key from the environment only, in the afloat_ format, before any request', () => {
    const options = live()

    expect(liveInputs(afloatRunner, options, {})).toEqual({
      refusal: 'AFLOAT_API_KEY is required for --live'
    })
    expect(
      liveInputs(afloatRunner, options, { AFLOAT_API_KEY: 'sk-synthetic-not-afloat' })
    ).toEqual({
      refusal:
        'AFLOAT_API_KEY must be an Afloat API key: afloat_ followed by 16 to 256 letters and digits'
    })
    expect(() => live(['--api-key', liveKey])).toThrow('Unknown argument (not shown)')
    // The whole case list needs the call seeds; the live runner leaves those cases out instead.
    expect(liveInputs(afloatRunner, options, { AFLOAT_API_KEY: liveKey })).toEqual({
      refusal:
        'Missing seed identities for the cases that would run: --read-tool, --read-args, --invalid-args'
    })
    expect(liveInputs(liveRunnerFor(options), options, { AFLOAT_API_KEY: liveKey })).toEqual({
      inputs: { account: 'practice', accessToken: liveKey, seeds: {} }
    })
  })

  it('validates the call seeds: a tool name and JSON objects', () => {
    expect(decodeMcpSeeds({ readTool: 'list-invoices', readArgs: '{"size":10}' })).toEqual(
      Option.some({ readTool: 'list-invoices', readArgs: '{"size":10}' })
    )

    for (const invalid of [
      { readTool: 'two words' },
      { readTool: '' },
      { readArgs: '[1]' },
      { readArgs: 'not json' },
      { invalidArgs: '"text"' }
    ]) {
      expect(decodeMcpSeeds(invalid), JSON.stringify(invalid)).toEqual(Option.none())
    }

    const options = live(['--read-tool', 'list-invoices', '--read-args', '[]'])

    expect(liveInputs(liveRunnerFor(options), options, { AFLOAT_API_KEY: liveKey })).toEqual({
      refusal: afloatRunner.invalidSeedsMessage
    })
  })
})

describe('run-mcp-conformance plan', () => {
  it('a dry run reads no credential, lists the era filter, and calls no tool without --read-tool', () => {
    const { env, reads } = watchedEnv({ AFLOAT_API_KEY: liveKey })
    const { io, out, err, codes } = cliIo()

    expect(prepareMcpRun(['--target', 'afloat'], env, io)).toBeUndefined()
    expect(reads).not.toContain('AFLOAT_API_KEY')
    expect(err).toEqual([])
    expect(codes).toEqual([])

    const plan = out.join('\n')

    expect(plan).toContain('DRY RUN: no network request was made and no credential was read.')
    expect(plan).toContain('RUN   mcp.negotiation.era  [read]')
    expect(plan).toContain(
      'SKIP  mcp.tools.call-read  [read]  calls a tool only with --read-tool, --read-args'
    )
    expect(plan).toContain(
      'SKIP  mcp.tools.call-tool-error  [read]  calls a tool only with --read-tool, --invalid-args'
    )
    expect(plan).toContain('N/A   mcp.legacy.session  Afloat is a modern 2026-07-28 server')
  })

  it('a live run leaves the calling cases out unless their tool and arguments are named', () => {
    const ids = (argv: ReadonlyArray<string>) =>
      liveRunnerFor(live(argv)).cases.map(testCase => testCase.id)

    const named = ['--read-tool', 'list-invoices', '--read-args', '{"size":10}']

    expect(callingCaseIds).toEqual(['mcp.tools.call-read', 'mcp.tools.call-tool-error'])
    expect(ids([])).toEqual(
      afloatCases.map(testCase => testCase.id).filter(id => !callingCaseIds.includes(id))
    )
    expect(ids(named)).toContain('mcp.tools.call-read')
    expect(ids(named)).not.toContain('mcp.tools.call-tool-error')
    expect(ids([...named, '--invalid-args', '{"size":"ten"}'])).toEqual(
      afloatCases.map(testCase => testCase.id)
    )
  })

  it('the live seeds name no tool; named calls become the read seeds', () => {
    expect(mcpConformanceSeedsFor({})).toEqual(afloatMcpConformanceLiveSeeds)
    expect(mcpConformanceSeedsFor(afloatRunnerFixtureSeeds)).toEqual(
      afloatMcpConformanceFixtureSeeds
    )
  })

  it('refuses before reading a key for every gate, and prepares a live run only past them', () => {
    const refused = (argv: ReadonlyArray<string>, values: Record<string, string>) => {
      const { env, reads } = watchedEnv(values)
      const { io, err, codes } = cliIo()

      expect(prepareMcpRun(argv, env, io)).toBeUndefined()
      expect(codes).toEqual([1])
      expect(reads).not.toContain('AFLOAT_API_KEY')

      return err.join('\n')
    }

    const base = ['--target', 'afloat', '--live', '--owner-approved', '--account', 'practice']

    expect(refused(base, { CI: '1', AFLOAT_API_KEY: liveKey })).toBe(liveInCiMessage)
    expect(
      refused(['--target', 'afloat', '--live', '--account', 'practice'], {
        AFLOAT_API_KEY: liveKey
      })
    ).toBe(ownerApprovalRequiredMessage)
    expect(refused(['--target', 'figma', '--live'], { AFLOAT_API_KEY: liveKey })).toBe(
      figmaBlockedMessage
    )

    const { io } = cliIo()
    const prepared = prepareMcpRun(base, { AFLOAT_API_KEY: liveKey }, io)

    expect(prepared?.inputs).toEqual({ account: 'practice', accessToken: liveKey, seeds: {} })
    expect(prepared?.runner.cases.map(testCase => testCase.id)).not.toContain('mcp.tools.call-read')
  })
})

describe('run-mcp-conformance case layer (replay, no network)', () => {
  it('every case passes over the runner layer; the target comes from afloat.mcp_auth', async () => {
    const report = await Effect.runPromise(
      runConformance(afloatCases, {
        target: { kind: 'replay' },
        layer: testCase => {
          const fixture = afloatMcpConformanceFixtureFor(testCase.id)

          return afloatCasePorts(
            ReplayHttpClient.layer(fixture === undefined ? [] : [fixture]),
            afloatReplayKey,
            afloatRunnerFixtureSeeds
          )
        }
      })
    )

    expect(report.summary, formatConformanceReport(report)).toEqual({
      passed: afloatCases.length,
      failed: 0,
      skipped: 0
    })
  })
})

const liveInputsOf = (seeds: McpRunnerSeeds = {}): LiveInputs<McpRunnerSeeds> => ({
  account: 'practice',
  accessToken: liveKey,
  seeds
})

describe('run-mcp-conformance live run wiring (replay, no network)', () => {
  it('prints the report without any trace of the live key', async () => {
    const out: Array<string> = []
    const err: Array<string> = []

    const runner = {
      ...liveRunnerFor(live()),
      cases: afloatCases.filter(testCase =>
        ['mcp.negotiation.era', 'mcp.tools.list'].includes(testCase.id)
      )
    }

    await Effect.runPromise(
      runLive(runner, live(), liveInputsOf(), {
        http: ReplayHttpClient.layer([afloatMcpNegotiationEraFixture]),
        out: line => {
          out.push(line)
        },
        err: line => {
          err.push(line)
        }
      })
    )

    const printed = [...out, ...err].join('\n')

    expect(printed).toContain('PASS  mcp.negotiation.era')
    expect(printed).toContain('PASS  mcp.tools.list')
    expect(textContainsAccessToken(printed, liveKey)).toBe(false)
  })

  it('redacts the live key from every CLI error line', () => {
    const errors: Array<string> = []

    const io: CliIo = runnerLiveSecrets(afloatRunner, liveInputsOf()).reduce(redactingCliIo, {
      error: (message: string) => {
        errors.push(message)
      },
      setExitCode: () => undefined,
      forceExit: () => undefined
    })

    io.error(`failed with key ${liveKey}`)

    expect(textContainsAccessToken(errors.join('\n'), liveKey)).toBe(false)
  })
})

const recorderOf = (exchanges: ReadonlyArray<WireExchange>): WireRecorderApi => ({
  drain: Effect.succeed(exchanges)
})

const passedReport = (caseIds: ReadonlyArray<string>): ConformanceReport => ({
  target: { kind: 'live', account: 'practice' },
  startedAt: '2026-10-02T12:00:00.000Z',
  results: caseIds.map(id => ({
    id,
    safety: 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const memoryWriter = () => {
  const files = new Map<string, string>()
  const operations: Array<string> = []

  const writer: RecordingWriter = {
    exists: path => [...files.keys()].some(file => file === path || file.startsWith(`${path}/`)),
    mkdir: path => {
      operations.push(`mkdir ${path}`)
    },
    writeFile: (path, contents) => {
      operations.push(`write ${path}`)
      files.set(path, contents)
    },
    rename: (from, to) => {
      operations.push(`rename ${from} -> ${to}`)

      for (const [path, contents] of [...files].filter(([path]) => path.startsWith(`${from}/`))) {
        files.delete(path)
        files.set(to + path.slice(from.length), contents)
      }
    },
    rm: path => {
      operations.push(`rm ${path}`)
    },
    realpath: path => path,
    inspect: path => ({ kind: 'present', realpath: path })
  }

  return { writer, files, operations }
}

const recordingsRoot = recordingsRootFor(afloatRunner.provider)

const stagingDir = join(
  recordingsRoot,
  recordingRunId(new Date('2026-10-02T12:34:56.789Z'), 'a1b2c3d4')
)

const stageWith = (
  fixtures: ReadonlyArray<WireFixture>,
  writer: RecordingWriter,
  inputs: LiveInputs<McpRunnerSeeds> = liveInputsOf()
) => {
  const recorders = new Map(
    fixtures.map(fixture => [fixture.caseId, recorderOf(fixture.exchanges)] as const)
  )

  return Effect.runPromise(
    stageRecordings(afloatRunner, passedReport([...recorders.keys()]), recorders, inputs, {
      writer,
      stagingDir,
      recordedAt: '2026-10-02'
    }).pipe(Effect.result)
  )
}

describe('run-mcp-conformance --record staging (offline)', () => {
  it('stages under .conformance-recordings/mcp/afloat for wholesale synthetic replacement', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'mcp', 'afloat'))

    const { writer, files } = memoryWriter()

    const result = await stageWith(
      [afloatMcpToolsListFixture, afloatMcpAuthRejectedFixture],
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    expect([...files.keys()].sort()).toEqual(
      ['auth-rejected.ts', 'seeds.ts', 'tools-list.ts'].map(name => join(stagingDir, name))
    )

    const staged = [...files.values()].join('\n')

    expect(staged).toContain('pnpm conformance:mcp --target afloat --live --owner-approved')
    expect(textContainsAccessToken(staged, liveKey)).toBe(false)

    const checklist = result.success.checklist.join('\n')

    expect(checklist).toContain('REVIEW before promoting (staged files hold practice-account data')
    expect(checklist).toContain('replace every tools/call answer body wholesale')
    expect(checklist).toContain('copy into packages/connectors/src/afloat/conformance/')
    // Every string value is listed for review.
    expect(checklist).toContain('"Authentication required."')
  })

  it('writes nothing when a recording carries the live key', async () => {
    const { writer, operations } = memoryWriter()
    const [probe, listing] = afloatMcpNegotiationEraFixture.exchanges

    if (probe === undefined || listing === undefined) {
      return expect.fail('no exchanges')
    }

    const leaked: WireFixture = {
      ...afloatMcpNegotiationEraFixture,
      exchanges: [
        probe,
        {
          ...listing,
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ echoed: encodeURIComponent(liveKey) })
          }
        }
      ]
    }

    const result = await stageWith([leaked], writer)

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      'mcp.negotiation.era: the recording still contains the live access token; nothing was written'
    )
    expect(operations).toEqual([])
  })
})

const runCli = (argv: ReadonlyArray<string>, env: Record<string, string>) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, runnerScript, ...argv],
      { cwd: repoRoot, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

describe('run-mcp-conformance CLI', () => {
  it('dry-runs by default without a key', async () => {
    const result = await runCli(['--target', 'afloat'], { AFLOAT_API_KEY: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('N/A   mcp.legacy.session')
  })

  it('refuses --live in CI before reading the key', async () => {
    const result = await runCli(
      ['--target', 'afloat', '--live', '--owner-approved', '--account', 'practice'],
      { AFLOAT_API_KEY: '', CI: '1' }
    )

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })

  it('refuses a missing or blocked target', async () => {
    expect((await runCli([], { CI: '' })).stderr).toContain(missingTargetMessage)
    expect((await runCli(['--target', 'figma'], { CI: '' })).stderr).toContain(figmaBlockedMessage)
  })
})

/** The secret part of the synthetic live key: everything after `afloat_`. */
const liveRemainder = liveKey.slice('afloat_'.length)

/** Every encoded form of the remainder alone (no `afloat_` prefix) a provider could echo. */
const remainderForms: ReadonlyArray<readonly [string, string]> = [
  ['raw', liveRemainder],
  [
    'percent-encoded',
    [...liveRemainder].map(character => `%${character.charCodeAt(0).toString(16)}`).join('')
  ],
  [
    'JSON-escaped',
    [...liveRemainder]
      .map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('')
  ],
  ['base64', Buffer.from(liveRemainder, 'utf8').toString('base64')]
]

describe('run-mcp-conformance guards the key remainder (afloat_ is public)', () => {
  it('the remainder is a guarded secret part under the token name', () => {
    expect(afloatKeySecretParts(liveKey)).toEqual([liveRemainder])
    expect(afloatKeySecretParts('not-an-afloat-key')).toEqual([])
    expect(namedLiveSecrets(afloatRunner, liveInputsOf())).toEqual([
      { label: 'the live access token', secret: liveKey },
      { label: 'the live access token', secret: liveRemainder }
    ])
    expect(runnerLiveSecrets(afloatRunner, liveInputsOf())).toEqual([liveKey, liveRemainder])
  })

  for (const [form, echoed] of remainderForms) {
    it(`stages nothing when a recording echoes the remainder alone (${form})`, async () => {
      const { writer, operations } = memoryWriter()
      const [probe, listing] = afloatMcpNegotiationEraFixture.exchanges

      if (probe === undefined || listing === undefined) {
        return expect.fail('no exchanges')
      }

      // The remainder alone, without `afloat_`: the shared prefix scan cannot see it.
      expect(echoed.includes('afloat_')).toBe(false)

      const leaked: WireFixture = {
        ...afloatMcpNegotiationEraFixture,
        exchanges: [
          probe,
          {
            ...listing,
            response: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: `{"result":{"tools":[],"note":"${echoed}"},"jsonrpc":"2.0","id":0}`
            }
          }
        ]
      }

      const result = await stageWith([leaked], writer)

      expect(Result.isFailure(result) ? result.failure.message : '').toBe(
        'mcp.negotiation.era: the recording still contains the live access token; nothing was written'
      )
      expect(operations).toEqual([])
    })

    it(`redacts the remainder alone from every printed line (${form})`, () => {
      const printed: Array<string> = []
      const secrets = runnerLiveSecrets(afloatRunner, liveInputsOf())

      const cli: CliIo = secrets.reduce(redactingCliIo, {
        error: (message: string) => {
          printed.push(message)
        },
        setExitCode: () => undefined,
        forceExit: () => undefined
      })

      const run = secrets.reduce(redactingLiveRunIo, {
        http: ReplayHttpClient.layer([]),
        out: (line: string) => {
          printed.push(line)
        },
        err: (line: string) => {
          printed.push(line)
        }
      })

      cli.error(`refused: the server said ${echoed}`)
      run.out(`FAIL  mcp.tools.list  the tool description was ${echoed}`)
      run.err(`WARN the cleanup saw ${echoed}`)

      const text = printed.join('\n')

      expect(printed).toHaveLength(3)
      expect(textContainsAccessToken(text, liveRemainder)).toBe(false)
      expect(textContainsAccessToken(text, liveKey)).toBe(false)
    })
  }
})

describe('run-mcp-conformance argument errors never repeat a value', () => {
  const refusalOf = (argv: ReadonlyArray<string>) => {
    const { env, reads } = watchedEnv({ AFLOAT_API_KEY: liveKey })
    const { io, err, codes } = cliIo()

    expect(prepareMcpRun(argv, env, io)).toBeUndefined()
    expect(codes).toEqual([1])
    expect(reads).not.toContain('AFLOAT_API_KEY')

    const message = err.join('\n')

    expect(message).not.toContain(liveKey)
    expect(textContainsAccessToken(message, liveRemainder)).toBe(false)

    return message
  }

  it('an inline credential flag is never shown, not even its flag name', () => {
    expect(refusalOf(['--target', 'afloat', `--api-key=${liveKey}`])).toBe(
      'Unknown argument (not shown)'
    )
  })

  it('a key passed as the target, or as a stray argument, is never shown', () => {
    expect(refusalOf(['--target', liveKey])).toBe('Unknown --target: afloat is the only MCP target')
    expect(refusalOf([`--target=${liveKey}`])).toBe(
      'Unknown --target: afloat is the only MCP target'
    )
    expect(refusalOf(['--target', 'afloat', liveKey])).toBe('Unknown argument (not shown)')
  })

  it('a flag-shaped secret (`--<remainder>`) is never shown', () => {
    expect(refusalOf(['--target', 'afloat', `--${liveRemainder}`])).toBe(
      'Unknown argument (not shown)'
    )

    // A provider-shaped key: 64 hex characters, a valid flag name once prefixed with `--`.
    const hexRemainder = '0123456789abcdef'.repeat(4).replace('0', 'a')
    const { io, err } = cliIo()

    expect(prepareMcpRun(['--target', 'afloat', `--${hexRemainder}`], {}, io)).toBeUndefined()
    expect(err).toEqual(['Unknown argument (not shown)'])
    expect(err.join('\n')).not.toContain(hexRemainder.slice(0, 16))
  })
})

describe('run-mcp-conformance: no tool call from the environment', () => {
  const callEnv = {
    MCP_CONFORMANCE_READ_TOOL: 'list-invoices',
    MCP_CONFORMANCE_READ_ARGS: '{"size":10}',
    MCP_CONFORMANCE_INVALID_ARGS: '{"size":"ten"}'
  }

  it('the call seeds are flags only: the environment names no seed', () => {
    expect(afloatRunner.seedSources.map(source => source.env)).toEqual([
      undefined,
      undefined,
      undefined
    ])
    expect(
      parse(['--target', 'afloat', '--live', '--owner-approved', '--account', 'practice'], callEnv)
        .seeds
    ).toEqual({})
  })

  it('with the call variables set and no flags, a live run sends zero tools/call of a real tool', async () => {
    const { io } = cliIo()

    const prepared = prepareMcpRun(
      ['--target', 'afloat', '--live', '--owner-approved', '--account', 'practice'],
      { ...callEnv, AFLOAT_API_KEY: liveKey },
      io
    )

    if (prepared === undefined) {
      return expect.fail('no live run prepared')
    }

    expect(prepared.inputs.seeds).toEqual({})
    expect(prepared.runner.cases.map(testCase => testCase.id)).not.toContain('mcp.tools.call-read')

    const sent: Array<HttpClientRequest.HttpClientRequest> = []

    const http = Layer.effect(
      HttpClient.HttpClient,
      makeReplayHttpClient(afloatMcpConformanceFixtures).pipe(
        Effect.map(({ client }) =>
          client.pipe(HttpClient.tapRequest(request => Effect.sync(() => sent.push(request))))
        )
      )
    )

    await Effect.runPromise(
      runLive(prepared.runner, prepared.options, prepared.inputs, {
        http,
        out: () => undefined,
        err: () => undefined
      })
    )

    const calls = sent.filter(request => request.headers['mcp-method'] === 'tools/call')

    expect(sent.length).toBeGreaterThan(0)
    // Only the absent-tool cases call, and only the name the listing proves absent.
    expect(calls.map(request => request.headers['mcp-name'])).toEqual(
      calls.map(() => 'yolk_conformance_absent')
    )
    expect(calls.some(request => request.headers['mcp-name'] === 'list-invoices')).toBe(false)
  })
})

/**
 * Truncated encoded echoes, through the real output path: a case fails with a server error that
 * echoes the 64-character remainder of a provider-shaped key, encoded, in a message longer than the
 * report's 300-character cap (which runs BEFORE redaction and cuts mid-escape); the report is
 * formatted and printed through the redacting IO a live run uses.
 */
describe('run-mcp-conformance withholds encoded fragments a report cap cut short', () => {
  const hexRemainder = '0123456789abcdef'.repeat(4)
  const hexKey = `afloat_${hexRemainder}`

  const unicodeEscaped = [...hexRemainder]
    .map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')

  const percentEncoded = [...hexRemainder]
    .map(character => `%${character.charCodeAt(0).toString(16)}`)
    .join('')

  const failing = (message: string) =>
    defineConformanceCase({
      id: 'mcp.synthetic.upstream-echo',
      title: 'a synthetic case failing with an upstream error',
      safety: 'read',
      docs: 'Test only.',
      wire: 'Test only.',
      fixtures: [],
      run: Effect.fail({ _tag: 'UpstreamFailed', message })
    })

  const cases: ReadonlyArray<readonly [string, string]> = [
    // 16 + 46 full escapes + `\u006`: the cap cuts mid-escape.
    ['\\u-escaped, no preceding text', `upstream error: ${unicodeEscaped}`],
    [
      '\\u-escaped, after preceding text',
      `upstream error: the provider answered a long synthetic explanation first, ${'x'.repeat(26)}, and then echoed ${unicodeEscaped}`
    ],
    [
      'percent-encoded, after preceding text',
      `upstream error: ${'the provider explains at length '.repeat(4)}${'y'.repeat(6)} then echoed ${percentEncoded}`
    ]
  ]

  for (const [label, message] of cases) {
    it(`withholds the whole line (${label})`, async () => {
      expect(message.length).toBeGreaterThan(300)

      const report = await Effect.runPromise(
        runConformance([failing(message)], {
          target: { kind: 'live', account: 'practice' },
          layer: () => Layer.empty
        })
      )

      const formatted = formatConformanceReport(report)
      const failureLine = formatted.split('\n')[0] ?? ''

      // The cap cut the echo short, mid-escape: the full remainder is gone, an encoded fragment
      // of at least 16 characters is not, and no raw fragment shows (the old raw-only check).
      expect(failureLine).toContain('...')
      expect(textContainsAccessToken(failureLine, hexKey)).toBe(false)
      expect(failureLine).not.toContain(hexRemainder.slice(0, 16))
      // Cut mid-escape: an incomplete `\u006` or `%6` right before the cap's `...`.
      expect(/(?:\\u00[0-9a-f]{0,2}|%[0-9a-f])\.\.\.  /.test(failureLine), failureLine).toBe(true)

      const printed: Array<string> = []

      const inputs: LiveInputs<McpRunnerSeeds> = {
        account: 'practice',
        accessToken: hexKey,
        seeds: {}
      }

      const io = runnerLiveSecrets(afloatRunner, inputs).reduce(redactingLiveRunIo, {
        http: ReplayHttpClient.layer([]),
        out: (line: string) => {
          printed.push(line)
        },
        err: (line: string) => {
          printed.push(line)
        }
      })

      io.out(formatted)

      const lines = printed.join('\n').split('\n')

      expect(lines[0]).toBe(withheldTokenLine)
      expect(lines.slice(1).join('\n')).toBe(formatted.split('\n').slice(1).join('\n'))
      expect(printed.join('\n')).not.toContain('upstream error')
    })
  }

  it('a short encoded echo below the fragment length is not withheld', async () => {
    const short = unicodeEscaped.slice(0, 6 * 8)

    const report = await Effect.runPromise(
      runConformance([failing(`upstream error: ${short}`)], {
        target: { kind: 'live', account: 'practice' },
        layer: () => Layer.empty
      })
    )

    const printed: Array<string> = []

    const inputs: LiveInputs<McpRunnerSeeds> = {
      account: 'practice',
      accessToken: hexKey,
      seeds: {}
    }

    runnerLiveSecrets(afloatRunner, inputs)
      .reduce(redactingLiveRunIo, {
        http: ReplayHttpClient.layer([]),
        out: (line: string) => {
          printed.push(line)
        },
        err: () => undefined
      })
      .out(formatConformanceReport(report))

    expect(printed.join('\n')).toContain('upstream error')
  })
})

/**
 * Truncated echoes in a recording: a provider-shaped key's 64-character remainder, cut to 63
 * characters plus `...` (all but one hex digit), in a tool description. Neither the complete
 * remainder nor the `afloat_` prefix is there, so only the fragment check can refuse it.
 */
describe('run-mcp-conformance stages nothing that holds a fragment of the key', () => {
  const hexRemainder = '0123456789abcdef'.repeat(4)
  const hexKey = `afloat_${hexRemainder}`

  const hexInputs: LiveInputs<McpRunnerSeeds> = {
    account: 'practice',
    accessToken: hexKey,
    seeds: {}
  }

  const cut = hexRemainder.slice(0, 63)

  const truncatedForms: ReadonlyArray<readonly [string, string]> = [
    ['raw', `${cut}...`],
    [
      '\\u-escaped',
      `${[...cut].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}...`
    ],
    [
      'percent-encoded',
      `${[...cut].map(character => `%${character.charCodeAt(0).toString(16)}`).join('')}...`
    ]
  ]

  /** The era fixture with the first listed tool's description replaced by `description`. */
  const withDescription = (description: string): WireFixture => {
    const [probe, listing] = afloatMcpNegotiationEraFixture.exchanges

    const original =
      listing !== undefined && Predicate.hasProperty(listing.response, 'body')
        ? listing.response.body
        : undefined

    if (probe === undefined || listing === undefined || !Predicate.isString(original)) {
      throw new Error('no listing')
    }

    const body = original.replace(
      '"description":"List issued invoices, one page at a time, optionally filtered by search text or payment status."',
      `"description":${JSON.stringify(description)}`
    )

    expect(body).not.toBe(original)

    const response = { status: listing.response.status, headers: listing.response.headers, body }

    return { ...afloatMcpNegotiationEraFixture, exchanges: [probe, { ...listing, response }] }
  }

  for (const [form, echoed] of truncatedForms) {
    it(`refuses a 63-character truncated remainder in a tool description (${form}), writing nothing`, async () => {
      // The complete secret is not there: the old whole-token check passes it.
      expect(textContainsAccessToken(echoed, hexKey)).toBe(false)
      expect(textContainsAccessToken(echoed, hexRemainder)).toBe(false)
      expect(textCarriesSecret(echoed, hexRemainder)).toBe(true)

      const { writer, operations } = memoryWriter()

      const result = await stageWith(
        [withDescription(`Synthetic tool. ${echoed}`)],
        writer,
        hexInputs
      )

      expect(Result.isFailure(result) ? result.failure.message : '').toBe(
        'mcp.negotiation.era: the recording still contains the live access token; nothing was written'
      )
      expect(operations).toEqual([])
    })
  }

  it('the final check over rendered text refuses the same truncated forms', () => {
    for (const [form, echoed] of truncatedForms) {
      const rendered = `export const fixture = ${JSON.stringify({ description: echoed })}`

      expect(textCarriesSecret(rendered, hexRemainder), form).toBe(true)
      expect(
        textCarriesSecret(`  tools-list.ts: every string value: "${echoed}"`, hexRemainder),
        form
      ).toBe(true)
    }

    expect(textCarriesSecret(`description: ${hexRemainder.slice(0, 8)}`, hexRemainder)).toBe(false)
  })

  it('a short 8-character fragment still stages', async () => {
    const { writer, files } = memoryWriter()

    const result = await stageWith(
      [withDescription(`Synthetic tool. ${hexRemainder.slice(0, 8)}...`)],
      writer,
      hexInputs
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    expect([...files.keys()].sort()).toEqual(
      ['negotiation-era.ts', 'seeds.ts'].map(name => join(stagingDir, name))
    )
    expect([...files.values()].join('\n')).toContain(`${hexRemainder.slice(0, 8)}...`)
  })
})
