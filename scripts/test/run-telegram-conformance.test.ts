import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import type { WireExchange, WireResponse } from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  telegramConformanceCases,
  telegramConformanceFixtureSeeds,
  telegramConformanceFixtures,
  telegramConformanceReplayBotToken,
  telegramErrorEnvelopeFixture,
  telegramGetFilePathFixture,
  telegramSendMessageFixture,
  telegramValidateGetChatFixture
} from '../../packages/connectors/src/telegram/conformance/index.ts'
import {
  accessTokenForms,
  inspectRecordingForAccessToken,
  runInterruptibly,
  interruptOptionsFor,
  textContainsAccessToken,
  type CliIo,
  type SignalSource,
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
import { todoistRunner } from '../run-todoist-conformance.ts'
import { dropboxConformanceFixtures } from '../../packages/connectors/src/dropbox/conformance/index.ts'
import { notionConformanceFixtures } from '../../packages/connectors/src/notion/conformance/index.ts'
import { todoistConformanceFixtures } from '../../packages/connectors/src/todoist/conformance/index.ts'

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

  it('refuses a live token that is not <bot id>:<secret>, without printing it', () => {
    const checked = liveInputs(telegramRunner, live(seedFlags), {
      TELEGRAM_BOT_TOKEN: 'not a bot token/../x'
    })

    expect(checked).toEqual({
      refusal:
        'TELEGRAM_BOT_TOKEN must be a bot token of the form <bot id>:<secret> (digits, a colon, then letters, digits, _ or -)'
    })
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

const liveSecret = 'synthetic-live-token'

/** Every character as a `%XX` escape, letters included. */
const fullyPercentEncoded = (text: string) =>
  Array.from(text, char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')

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
    expect(inspectRecordingForAccessToken(recorded, liveToken)).toBe('token')
    expect(
      inspectRecordingForAccessToken(scrubTelegramRecording(recorded, liveToken), liveToken)
    ).toBe('clean')
  })

  it('finds the token or its secret part raw, percent-encoded, or escaped in any text', () => {
    for (const text of [
      liveToken,
      encodeURIComponent(liveToken),
      fullyPercentEncoded(liveToken),
      `\\u0039${liveToken.slice(1)}`,
      `&#57;${liveToken.slice(1)}`,
      liveSecret
    ]) {
      expect(textContainsAccessToken(text, liveToken)).toBe(true)
    }

    // Folded (MIME-style, 76 columns) base64 whose fold falls inside the encoded token.
    const encoded = Buffer.from(`${'A'.repeat(40)}${liveToken}${'B'.repeat(40)}`).toString('base64')
    const folded = encoded.match(/.{1,76}/g)?.join('\r\n') ?? expect.fail('fold')

    // No contiguous form survives the fold, so only the unfolded search can find it.
    expect(accessTokenForms(liveToken).some(form => folded.includes(form))).toBe(false)
    expect(textContainsAccessToken(folded, liveToken)).toBe(true)
    expect(textContainsAccessToken(folded.replaceAll('\r\n', '\\r\\n'), liveToken)).toBe(true)

    // A clean folded payload is not flagged.
    const clean = Buffer.from('plain synthetic attachment text '.repeat(8)).toString('base64')

    expect(textContainsAccessToken(clean.match(/.{1,76}/g)?.join('\n') ?? '', liveToken)).toBe(
      false
    )

    // The public bot id alone is not a secret: every sendMessage answer carries it as from.id.
    expect(textContainsAccessToken('{"from":{"id":987654321}}', liveToken)).toBe(false)
    expect(textContainsAccessToken('https://x.test/other', liveToken)).toBe(false)
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
          telegramErrorEnvelopeFixture,
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
      [
        'error-envelope.ts',
        'get-file-path.ts',
        'seeds.ts',
        'send-message.ts',
        'validate-get-chat.ts'
      ].map(name => join(stagingDir, name))
    )
    expect(staged).not.toContain(liveToken)
    expect(staged).not.toContain(liveSecret)
    expect(staged).toContain(`/bot${telegramConformanceReplayBotToken}/getChat`)
    // The error case's own synthetic invalid token is not the live one: it stays as recorded.
    expect(staged).toContain('/bot0:yolk-conformance-invalid-token/getChat')
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

  const validateCaseId = telegramValidateGetChatFixture.caseId

  /** The validate recording, as live, with its response (and optionally its URL) replaced. */
  const leakyValidate = (response: WireResponse, url?: string): ReadonlyArray<WireExchange> =>
    asRecordedLive(telegramValidateGetChatFixture.exchanges).map(exchange => ({
      request: url === undefined ? exchange.request : { ...exchange.request, url },
      response
    }))

  const json = (body: string): WireResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body
  })

  const tokenBytes = (prefix: ReadonlyArray<number>) =>
    Buffer.from([...prefix, ...Buffer.from(liveToken, 'ascii')]).toString('base64')

  const refusal = `${validateCaseId}: the recording still contains the live access token; nothing was written`

  const uninspectable = `${validateCaseId}: the recording holds a body the token guard cannot inspect (only strict UTF-8 text without NUL characters is inspectable); nothing was written`

  const binary = (bytes: ReadonlyArray<number>): WireResponse => ({
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    bodyBase64: Buffer.from(bytes).toString('base64')
  })

  /** Base64 of the token behind `offset` filler bytes, as a JSON body carrying it as a blob. */
  const base64Blob = (offset: number, urlSafe: boolean) => {
    const encoded = Buffer.concat([
      Buffer.alloc(offset, 0x41),
      Buffer.from(`${liveToken}!`)
    ]).toString(urlSafe ? 'base64url' : 'base64')

    return json(`{"ok":true,"result":{"blob":"${encoded}"}}`)
  }

  for (const [label, exchanges, message] of [
    [
      'a Unicode-escaped JSON body',
      leakyValidate(
        json(
          `{"ok":true,"result":{"id":-1001000000001,"title":"\\u0039${liveToken.slice(1)}","type":"supergroup"}}`
        )
      ),
      refusal
    ],
    [
      'a base64 binary body',
      leakyValidate({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        bodyBase64: tokenBytes([0xff, 0xfe, 0x00])
      }),
      refusal
    ],
    [
      'a token split across stream chunks (text and base64)',
      leakyValidate({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: [
          `data: {"t":"${liveToken.slice(0, 20)}`,
          { base64: Buffer.from(`${liveToken.slice(20)}"}\n\n`).toString('base64') }
        ]
      }),
      refusal
    ],
    [
      'a percent-encoded token in the URL',
      leakyValidate(
        json('{"ok":true,"result":{"id":-1001000000001,"type":"supergroup"}}'),
        `https://api.telegram.org/bot${fullyPercentEncoded(liveToken)}/getChat`
      ),
      refusal
    ],
    [
      'a token in a response header',
      leakyValidate({
        status: 200,
        headers: { 'content-type': 'application/json', 'x-echo': liveToken },
        body: '{"ok":true,"result":{"id":-1001000000001,"type":"supergroup"}}'
      }),
      refusal
    ],
    [
      'the secret part alone in a body',
      leakyValidate(json(`{"ok":true,"result":{"description":"${liveSecret}"}}`)),
      refusal
    ],
    [
      'an undecodable base64 body',
      leakyValidate({ status: 200, headers: {}, bodyBase64: 'not base64!' }),
      uninspectable
    ],
    ['a gzip body', leakyValidate(binary([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02])), uninspectable],
    [
      'an xz body (no magic-byte list: not strict UTF-8)',
      leakyValidate(binary([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04, 0xe6, 0xd6])),
      uninspectable
    ],
    [
      'a PNG-like body',
      leakyValidate(
        binary([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
      ),
      uninspectable
    ],
    [
      'a UTF-16 body with a byte-order mark',
      leakyValidate(binary([0xff, 0xfe, ...Buffer.from('plain synthetic text', 'utf16le')])),
      uninspectable
    ],
    [
      'a UTF-16 body without a byte-order mark (ASCII, so valid UTF-8, but NUL-laden)',
      leakyValidate(binary([...Buffer.from('plain synthetic text', 'utf16le')])),
      uninspectable
    ],
    [
      'a text body carrying NUL characters',
      leakyValidate(json(`{"ok":true,"result":{"title":"a${String.fromCharCode(0)}b"}}`)),
      uninspectable
    ],
    [
      'a MIME-folded base64 token in a text body',
      leakyValidate({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: (
          Buffer.from(`${'A'.repeat(40)}${liveToken}${'B'.repeat(40)}`)
            .toString('base64')
            .match(/.{1,76}/g) ?? []
        ).join('\r\n')
      }),
      refusal
    ],
    ...[0, 1, 2].flatMap(offset =>
      [false, true].map(
        urlSafe =>
          [
            `a base64${urlSafe ? 'url' : ''}-embedded token at byte offset ${offset}`,
            leakyValidate(base64Blob(offset, urlSafe)),
            refusal
          ] as const
      )
    )
  ] as const) {
    it(`writes and prints nothing for ${label}`, async () => {
      const { writer, operations } = memoryWriter()

      const result = await stageWith(
        telegramRunner,
        new Map([[validateCaseId, recorderOf(exchanges)]]),
        writer
      )

      const failure = Result.isFailure(result) ? result.failure.message : expect.fail('staged')

      expect(failure).toBe(message)
      expect(failure).not.toContain(liveSecret)
      expect(operations).toEqual([])
    })
  }

  it('writes and prints nothing when a seed would carry the token into seeds.ts', async () => {
    const { writer, operations } = memoryWriter()

    const result = await Effect.runPromise(
      stageRecordings(
        telegramRunner,
        passedReport([validateCaseId]),
        new Map([
          [validateCaseId, recorderOf(asRecordedLive(telegramValidateGetChatFixture.exchanges))]
        ]),
        { ...recordInputs, seeds: { ...recordInputs.seeds, chatId: liveToken } },
        { writer, stagingDir, recordedAt: '2026-09-30' }
      ).pipe(Effect.result)
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      'The staged files or the review checklist would contain the live access token; nothing was written'
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

  it('prints no trace of the live token when every request fails', async () => {
    const out: Array<string> = []
    const err: Array<string> = []

    // An empty replay fails every request closed, as a dropped connection would.
    await Effect.runPromise(
      runLive(telegramRunner, live(['--allow-irreversible', sendCaseId]), recordInputs, {
        http: ReplayHttpClient.layer([]),
        out: line => {
          out.push(line)
        },
        err: line => {
          err.push(line)
        }
      })
    )

    const printed = [...out, ...err].join('\n')

    expect(printed).toContain('FAIL  telegram.messages.send-message')
    expect(printed).not.toContain(liveSecret)
    expect(textContainsAccessToken(printed, liveToken)).toBe(false)
  })

  it('skips the send unless its exact id was given, and runs it when it was', async () => {
    expect((await runOver(['--allow-writes', 'reversible'])).split('\n')[0]).toBe(
      'SKIP  telegram.messages.send-message  [write-irreversible]  manual-only  warnings: unverified-case'
    )
    // With the irreversible send enabled, the run id is printed first, before any case runs.
    expect((await runOver(['--allow-irreversible', sendCaseId])).split('\n').slice(0, 2)).toEqual([
      'runId for this run: run-synthetic (write-irreversible cases name it in what they leave behind)',
      'PASS  telegram.messages.send-message  [write-irreversible]  warnings: unverified-case'
    ])
  })
})

describe('run-telegram-conformance interruption advice', () => {
  it('points at the chat, never at a leftover lookup Telegram does not have', async () => {
    const errors: Array<string> = []
    let handlers: Array<() => void> = []

    const signals: SignalSource = {
      on: (_signal, handler) => {
        handlers = [...handlers, handler]
      },
      off: () => {
        handlers = []
      }
    }

    const io: CliIo = {
      error: message => {
        errors.push(message)
      },
      setExitCode: () => undefined,
      forceExit: () => undefined
    }

    let clock = 0

    const done = runInterruptibly(Effect.never, signals, io, {
      now: () => clock,
      pid: 4242,
      ...interruptOptionsFor(telegramRunner)
    })

    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    handlers[0]?.()
    clock += 2000
    handlers[0]?.()
    await done

    expect(errors[0]).toContain(
      'SIGINT: interrupting the run (pid 4242); a write already in flight completes before exit'
    )
    expect(errors[1]).toBe(
      `Second SIGINT: exiting now without waiting for cleanup. ${telegramRunner.recoveryAdvice}`
    )
    expect(errors.at(-1)).toBe(`Interrupted. Read the WARN lines. ${telegramRunner.recoveryAdvice}`)
    expect(errors.join('\n')).not.toContain('--allow-writes')
    expect(telegramRunner.recoveryAdvice).toContain(
      'messages starting with `yolk-conformance run-`'
    )
  })

  it('words the first signal from whether the runner cleans up, not from its advice', () => {
    expect(interruptOptionsFor(telegramRunner)).toEqual({
      recoveryAdvice: telegramRunner.recoveryAdvice,
      hasCleanups: false
    })
    expect(interruptOptionsFor(todoistRunner)).toEqual({
      recoveryAdvice: undefined,
      hasCleanups: true
    })
    expect(interruptOptionsFor({ ...todoistRunner, recoveryAdvice: 'custom advice' })).toEqual({
      recoveryAdvice: 'custom advice',
      hasCleanups: true
    })
  })
})

describe('connector conformance token guard allowlist', () => {
  // Every committed fixture is strict UTF-8 text, so every runner's recordings stay stageable.
  for (const [provider, fixtures] of [
    ['dropbox', dropboxConformanceFixtures],
    ['notion', notionConformanceFixtures],
    ['todoist', todoistConformanceFixtures],
    ['telegram', telegramConformanceFixtures]
  ] as const) {
    it(`inspects every ${provider} fixture as clean`, () => {
      for (const fixture of fixtures) {
        expect(inspectRecordingForAccessToken(fixture.exchanges, liveToken)).toBe('clean')
      }
    })
  }
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
