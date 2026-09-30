import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import type { WireExchange } from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  telegramConformanceCases,
  telegramConformanceFixtureSeeds,
  telegramConformanceReplayBotToken,
  telegramGetFilePathFixture,
  telegramSendMessageFixture,
  telegramValidateGetChatFixture
} from '../../packages/connectors/src/telegram/conformance/index.ts'
import {
  containsAccessToken,
  defaultRunOptions,
  dryRunReport,
  leftoverWarnings,
  liveInCiMessage,
  liveInputs,
  liveTarget,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  planRun,
  recordingRunId,
  renderFixtureModule,
  renderSeedsModule,
  runLive,
  stageRecordings,
  usage,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  generateRunId,
  liveCredential,
  recordingsRoot,
  scrubTelegramRecording,
  telegramCaseSpecs,
  telegramRunner
} from '../run-telegram-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-telegram-conformance.ts')

const sendCaseId = 'telegram.messages.send-message'

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(telegramRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const seedFlags = ['--chat=-1001000000001', '--file-id=BQACAgIAAxkDAAIC-yolk_synthetic_file_0001']

describe('run-telegram-conformance arguments', () => {
  it('defaults to a dry run that starts no irreversible case', () => {
    expect(parse([])).toEqual(defaultRunOptions)
    expect(liveTarget(parse([]))).toEqual({
      kind: 'live',
      account: 'dry-run',
      allowWrites: 'none',
      allowIrreversible: []
    })
    expect(() =>
      parse(['--live', '--owner-approved', '--account', 'practice'], { CI: '1' })
    ).toThrow(liveInCiMessage)
    expect(() => parse(['--live', '--account', 'practice'])).toThrow(ownerApprovalRequiredMessage)
  })

  it('takes --allow-irreversible with the exact send case id only', () => {
    expect(
      parse(['--allow-irreversible', sendCaseId, `--allow-irreversible=${sendCaseId}`])
    ).toMatchObject({
      allowIrreversible: [sendCaseId]
    })
    expect(liveTarget(parse(['--allow-irreversible', sendCaseId]))).toMatchObject({
      allowWrites: 'none',
      allowIrreversible: [sendCaseId]
    })

    for (const wrong of ['telegram.messages', 'telegram.validate.get-chat', 'all']) {
      expect(() => parse(['--allow-irreversible', wrong])).toThrow(
        `--allow-irreversible takes an exact write-irreversible case id: ${sendCaseId}`
      )
    }

    expect(() => parse(['--allow-irreversible'])).toThrow('--allow-irreversible requires a value')
    expect(() => parse(['--run-id', 'run-mine'])).toThrow('Unknown argument: --run-id')
  })

  it('reads seeds from flags over env', () => {
    expect(
      parse(['--chat', '@yolk_practice'], {
        TELEGRAM_CONFORMANCE_CHAT: '-1001000000009',
        TELEGRAM_CONFORMANCE_FILE_ID: ' AbC_-1 '
      }).seeds
    ).toEqual({ chatId: '@yolk_practice', fileId: 'AbC_-1' })
  })

  it('documents the irreversible flag with its only case id', () => {
    expect(usage(telegramRunner)).toContain(
      `--allow-irreversible <case-id>  run this exact write-irreversible case, which cannot be undone`
    )
    expect(usage(telegramRunner)).toContain(`                                  ${sendCaseId}`)
    expect(usage(telegramRunner)).toContain('(this runner has none)')
  })
})

describe('run-telegram-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(telegramCaseSpecs.map(spec => spec.caseId)).toEqual(
      telegramConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of telegramCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/telegram/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('never plans the send without its exact id, whatever --allow-writes says', () => {
    const sendSkip = (argv: ReadonlyArray<string>) =>
      planRun(telegramRunner, parse(argv)).find(entry => entry.id === sendCaseId)?.skipReason

    expect(sendSkip([])).toBe('manual-only')
    expect(sendSkip(['--allow-writes', 'reversible'])).toBe('manual-only')
    expect(sendSkip(['--allow-irreversible', sendCaseId])).toBeUndefined()
  })

  it('prints a dry-run plan that says the send cannot be undone', () => {
    expect(dryRunReport(telegramRunner, parse([])).split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs TELEGRAM_BOT_TOKEN).',
      'Plan for a live target: allowWrites=none, allowIrreversible=[]',
      'RUN   telegram.validate.get-chat  [read]  needs --chat',
      'RUN   telegram.errors.error-envelope  [read]  needs --chat',
      'RUN   telegram.files.get-file-path  [read]  needs --file-id',
      'SKIP  telegram.messages.send-message  [write-irreversible]  manual-only',
      "Use a practice Telegram bot and chat only, with the repository owner's approval; never in CI. The write-irreversible telegram.messages.send-message case posts a real message naming a fresh run id to --chat that the connector cannot delete; it runs only with --allow-irreversible telegram.messages.send-message."
    ])
    expect(
      dryRunReport(telegramRunner, parse(['--allow-irreversible', sendCaseId])).split('\n')[1]
    ).toBe(`Plan for a live target: allowWrites=none, allowIrreversible=[${sendCaseId}]`)
  })
})

describe('run-telegram-conformance live refusal (no network)', () => {
  const env = { TELEGRAM_BOT_TOKEN: '987654321:synthetic-live-token' }

  it('refuses without a token or the seeds of a case that would run', () => {
    expect(liveInputs(telegramRunner, live(seedFlags), {})).toEqual({
      refusal: 'TELEGRAM_BOT_TOKEN is required for --live'
    })
    expect(liveInputs(telegramRunner, live(['--file-id=AbC_-1']), env)).toEqual({
      refusal: 'Missing seed identities for the cases that would run: --chat'
    })
    expect(
      liveInputs(telegramRunner, live(['--chat=not a chat', '--file-id=AbC_-1']), env)
    ).toEqual({ refusal: telegramRunner.invalidSeedsMessage })
  })

  it('generates a fresh run id for every invocation, for the send text', () => {
    const runIdOf = () => {
      const checked = liveInputs(
        telegramRunner,
        live(['--allow-irreversible', sendCaseId, ...seedFlags]),
        env
      )

      return 'inputs' in checked ? checked.inputs.seeds.runId : expect.fail(checked.refusal)
    }

    const first = runIdOf()

    expect(first).toMatch(/^run-[0-9a-f]{8}$/)
    expect(runIdOf()).not.toBe(first)
    expect(generateRunId()).toMatch(/^run-[0-9a-f]{8}$/)
  })

  it('binds the live token as an API key credential for the telegram.bot_token slot', () => {
    expect(liveCredential('987654321:synthetic-live-token')).toMatchObject({
      _tag: 'ApiKeyCredential',
      key: '987654321:synthetic-live-token'
    })
  })

  it('has no leftover lookup: a sent message is never cleaned up', async () => {
    expect(telegramRunner).not.toHaveProperty('leftovers')
    expect(
      await Effect.runPromise(
        leftoverWarnings(
          telegramRunner,
          live(['--allow-irreversible', sendCaseId]),
          recordInputs,
          ReplayHttpClient.layer([])
        )
      )
    ).toEqual([])
  })
})

const liveToken = '987654321:synthetic-live-token'

const recordInputs: LiveInputs<typeof telegramConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: liveToken,
  seeds: telegramConformanceFixtureSeeds
}

/** The committed exchanges as a live recording would see them: the live token in every URL. */
const asRecordedLive = (exchanges: ReadonlyArray<WireExchange>): ReadonlyArray<WireExchange> =>
  exchanges.map(exchange => ({
    ...exchange,
    request: {
      ...exchange.request,
      url: exchange.request.url.replaceAll(telegramConformanceReplayBotToken, liveToken)
    }
  }))

describe('run-telegram-conformance token scrubbing', () => {
  it('replaces the live bot token in every recorded URL, API and file downloads alike', () => {
    const recorded = asRecordedLive(telegramGetFilePathFixture.exchanges)

    expect(recorded.map(exchange => exchange.request.url)).toEqual([
      `https://api.telegram.org/bot${liveToken}/getFile?file_id=BQACAgIAAxkDAAIC-yolk_synthetic_file_0001`,
      `https://api.telegram.org/file/bot${liveToken}/documents/file_0.txt`
    ])
    expect(scrubTelegramRecording(recorded, liveToken)).toEqual(
      telegramGetFilePathFixture.exchanges
    )
    expect(containsAccessToken(recorded, liveToken)).toBe(true)
    expect(containsAccessToken(scrubTelegramRecording(recorded, liveToken), liveToken)).toBe(false)
  })

  it('finds the token verbatim, percent-encoded, or JSON-escaped', () => {
    const [exchange] = telegramValidateGetChatFixture.exchanges

    const withUrl = (url: string): ReadonlyArray<WireExchange> => [
      { ...exchange, request: { ...exchange.request, url } }
    ]

    expect(
      containsAccessToken(withUrl(`https://x.test/${encodeURIComponent(liveToken)}`), liveToken)
    ).toBe(true)
    expect(containsAccessToken(withUrl('https://x.test/other'), liveToken)).toBe(false)
  })
})

const recorderOf = (exchanges: ReadonlyArray<WireExchange>): WireRecorderApi => ({
  drain: Effect.succeed(exchanges)
})

const passedReport = (caseIds: ReadonlyArray<string>): ConformanceReport => ({
  target: { kind: 'live', account: 'practice' },
  startedAt: '2026-09-30T12:00:00.000Z',
  results: caseIds.map(id => ({
    id,
    safety: telegramConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
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

const stagingDir = join(
  recordingsRoot,
  recordingRunId(new Date('2026-09-30T12:34:56.789Z'), 'a1b2c3d4')
)

const stageWith = (
  runner: typeof telegramRunner,
  recorders: ReadonlyMap<string, WireRecorderApi>,
  writer: RecordingWriter
) =>
  Effect.runPromise(
    stageRecordings(runner, passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir,
      recordedAt: '2026-09-30'
    }).pipe(Effect.result)
  )

describe('run-telegram-conformance --record staging (offline)', () => {
  it('stages recordings with the replay token only, and replays them with it', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'telegram'))

    const { writer, files } = memoryWriter()

    const result = await stageWith(
      telegramRunner,
      new Map(
        [
          telegramValidateGetChatFixture,
          telegramGetFilePathFixture,
          telegramSendMessageFixture
        ].map(fixture => [fixture.caseId, recorderOf(asRecordedLive(fixture.exchanges))] as const)
      ),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    const staged = [...files.values()].join('\n')

    expect([...files.keys()].sort()).toEqual(
      ['get-file-path.ts', 'seeds.ts', 'send-message.ts', 'validate-get-chat.ts'].map(name =>
        join(stagingDir, name)
      )
    )
    expect(staged).not.toContain(liveToken)
    expect(staged).toContain(`/bot${telegramConformanceReplayBotToken}/getChat`)
    expect(staged).toContain(`/file/bot${telegramConformanceReplayBotToken}/documents/file_0.txt`)

    const checklist = result.success.checklist.join('\n')

    // Chat titles, bot names, file paths, and message text are listed for review.
    expect(checklist).toContain('"Synthetic practice group"')
    expect(checklist).toContain('"documents/file_0.txt"')
    expect(checklist).toContain(
      'text: "yolk-conformance run-synthetic: synthetic conformance message, safe to ignore"'
    )
  })

  it('writes nothing when a recording still carries the live token', async () => {
    const { writer, operations } = memoryWriter()

    // Without the scrub, the live token stays in every URL path (the secret scan cannot see it).
    const result = await stageWith(
      { ...telegramRunner, scrubRecording: (exchanges: ReadonlyArray<WireExchange>) => exchanges },
      new Map([
        [
          telegramValidateGetChatFixture.caseId,
          recorderOf(asRecordedLive(telegramValidateGetChatFixture.exchanges))
        ]
      ]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${telegramValidateGetChatFixture.caseId}: the recording still contains the live access token; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/telegram/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(telegramRunner, telegramConformanceFixtureSeeds)).toBe(committed)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      telegramCaseSpecs.find(entry => entry.caseId === telegramSendMessageFixture.caseId) ??
      expect.fail('missing send spec')

    expect(renderFixtureModule(telegramRunner, spec, telegramSendMessageFixture)).toContain(
      'export const telegramSendMessageFixture: WireFixture = {'
    )
  })
})

describe('run-telegram-conformance live run wiring', () => {
  const replayInputs = { ...recordInputs, accessToken: telegramConformanceReplayBotToken }

  // Only the send case: each case replays over a fresh client, and the send fixture alone.
  const sendOnly = {
    ...telegramRunner,
    cases: telegramConformanceCases.filter(testCase => testCase.id === sendCaseId)
  }

  const runOver = async (argv: ReadonlyArray<string>) => {
    const out: Array<string> = []

    await Effect.runPromise(
      runLive(sendOnly, live(argv), replayInputs, {
        http: ReplayHttpClient.layer([telegramSendMessageFixture]),
        out: line => {
          out.push(line)
        },
        err: () => undefined
      })
    )

    return out.join('\n')
  }

  it('skips the send unless its exact id was given, and runs it when it was', async () => {
    expect((await runOver(['--allow-writes', 'reversible'])).split('\n')[0]).toBe(
      'SKIP  telegram.messages.send-message  [write-irreversible]  manual-only  warnings: unverified-case'
    )
    expect((await runOver(['--allow-irreversible', sendCaseId])).split('\n')[0]).toBe(
      'PASS  telegram.messages.send-message  [write-irreversible]  warnings: unverified-case'
    )
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

describe('run-telegram-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { TELEGRAM_BOT_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain(
      'SKIP  telegram.messages.send-message  [write-irreversible]  manual-only'
    )
  })

  it('refuses an irreversible id that is not exact', async () => {
    const result = await runCli(['--allow-irreversible', 'telegram.messages'], {
      TELEGRAM_BOT_TOKEN: '',
      CI: ''
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(
      `--allow-irreversible takes an exact write-irreversible case id: ${sendCaseId}`
    )
  })
})
