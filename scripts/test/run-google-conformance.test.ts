import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '../../packages/conformance/src/fixture.ts'
import {
  makeRecordingHttpClient,
  type WireRecorderApi
} from '../../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  driveFolderLifecycleFixture,
  gmailDraftLifecycleFixture,
  gmailLabelLifecycleFixture,
  gmailNotFoundEnvelopeFixture,
  gmailSendPracticeFixture,
  googleConformanceCases,
  googleConformanceFixtures,
  googleConformanceFixtureSeeds,
  GoogleConformanceRunId
} from '../../packages/connectors/src/google/conformance/index.ts'
import {
  accessTokenRequiredMessage,
  defaultRunOptions,
  dryRunReport,
  inspectRecordingForAccessToken,
  interruptOptionsFor,
  leftoverWarnings,
  liveInCiMessage,
  liveInputs,
  liveTarget,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  planRun,
  recorderOptionsFor,
  recordingReviewChecklist,
  recordingRunId,
  redactAccessToken,
  redactedLiveTokenMarker,
  redactingCliIo,
  renderFixtureModule,
  renderSeedsModule,
  runInterruptibly,
  runLive,
  stageRecordings,
  textContainsAccessToken,
  usage,
  withheldTokenLine,
  type CliIo,
  type LiveInputs,
  type RecordingWriter,
  type SignalSource
} from '../connector-conformance-internal.ts'
import {
  generateRunId,
  googleCaseSpecs,
  googleRunner,
  liveCredential,
  recordingsRoot
} from '../run-google-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-google-conformance.ts')

const sendId = 'google.gmail.send-practice-address'

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(googleRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const allSeedFlags = [
  '--practice-address=practice@example.test',
  '--paging-label=Label_9001',
  '--attachment-message=18f00000000000a1',
  '--work-message=18f00000000000b1',
  '--calendar=practice-calendar@example.test',
  '--event-range-start=2026-09-01T00:00:00Z',
  '--event-range-end=2026-09-08T00:00:00Z',
  '--drive-folder=synthetic-practice-folder-0001',
  '--drive-file=synthetic-practice-file-0001'
]

// No long run of one character: the staging guard refuses any 16-character window of the token,
// and a run such as `0000000000000001` also occurs in the synthetic Gmail draft id.
const liveToken = 'ya29.SyntheticLiveGoogleAccessTokenQ7xLm2Pz9Rt4Vw1Ab'

const env = { GOOGLE_ACCESS_TOKEN: liveToken }

describe('run-google-conformance arguments', () => {
  it('defaults to a dry run that starts no write, and gates --live', () => {
    expect(parse([])).toEqual(defaultRunOptions)
    expect(liveTarget(parse([]))).toEqual({
      kind: 'live',
      account: 'dry-run',
      allowWrites: 'none',
      allowIrreversible: []
    })
    expect(() =>
      parse(['--live', '--owner-approved', '--account', 'practice'], { CI: 'false' })
    ).toThrow(liveInCiMessage)
    expect(() => parse(['--live', '--account', 'practice'])).toThrow(ownerApprovalRequiredMessage)
  })

  it('takes --allow-irreversible with the exact send case id only, and no run id flag', () => {
    expect(parse(['--allow-irreversible', sendId])).toMatchObject({ allowIrreversible: [sendId] })

    for (const wrong of ['google.gmail', 'google.gmail.draft-compose-update-delete', 'all']) {
      expect(() => parse(['--allow-irreversible', wrong])).toThrow(
        `--allow-irreversible takes an exact write-irreversible case id: ${sendId}`
      )
    }

    expect(() => parse(['--run-id', 'run-mine'])).toThrow('Unknown argument (not shown)')
    expect(() => parse(['--token', liveToken])).toThrow('Unknown argument (not shown)')
    expect(() => parse(['--to', 'someone@example.test'])).toThrow('Unknown argument (not shown)')
  })

  it('reads seeds from flags over env', () => {
    expect(
      parse(['--calendar', 'practice-calendar@example.test'], {
        GOOGLE_CONFORMANCE_CALENDAR: 'other@example.test',
        GOOGLE_CONFORMANCE_DRIVE_FOLDER: ' synthetic-practice-folder-0001 '
      }).seeds
    ).toEqual({
      calendarId: 'practice-calendar@example.test',
      driveFolderId: 'synthetic-practice-folder-0001'
    })
  })

  it('documents the irreversible flag with its only case id', () => {
    expect(usage(googleRunner)).toContain(`                                  ${sendId}`)
    expect(usage(googleRunner)).toContain('GOOGLE_ACCESS_TOKEN is read from the environment only')
  })
})

describe('run-google-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(googleCaseSpecs.map(spec => spec.caseId)).toEqual(
      googleConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of googleCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/google/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('runs reversible writes only when allowed and the send only by its exact id', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planRun(googleRunner, parse(argv))
        .filter(entry => entry.skipReason !== undefined)
        .map(entry => [entry.id, entry.skipReason])

    const reversible = googleConformanceCases
      .filter(testCase => testCase.safety === 'write-reversible')
      .map(testCase => testCase.id)

    expect(skips([])).toEqual(
      googleConformanceCases
        .filter(testCase => testCase.safety !== 'read')
        .map(testCase => [
          testCase.id,
          testCase.safety === 'write-irreversible' ? 'manual-only' : 'writes-not-allowed'
        ])
    )
    expect(skips(['--allow-writes', 'reversible'])).toEqual([[sendId, 'manual-only']])
    expect(skips(['--allow-irreversible', sendId])).toEqual(
      reversible.map(id => [id, 'writes-not-allowed'])
    )
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    expect(dryRunReport(googleRunner, parse(['--allow-irreversible', sendId])).split('\n')).toEqual(
      [
        'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs GOOGLE_ACCESS_TOKEN).',
        `Plan for a live target: allowWrites=none, allowIrreversible=[${sendId}]`,
        'RUN   google.gmail.list-page-token  [read]  needs --paging-label',
        'RUN   google.gmail.attachment-base64url  [read]  needs --attachment-message',
        'RUN   google.gmail.not-found-envelope  [read]',
        'SKIP  google.gmail.label-create-apply-delete  [write-reversible]  writes-not-allowed',
        'SKIP  google.gmail.draft-compose-update-delete  [write-reversible]  writes-not-allowed',
        'SKIP  google.gmail.trash-untrash  [write-reversible]  writes-not-allowed',
        `RUN   ${sendId}  [write-irreversible]  needs --practice-address`,
        'RUN   google.calendar.list-range-paging  [read]  needs --calendar, --event-range-start, --event-range-end',
        'SKIP  google.calendar.event-lifecycle  [write-reversible]  writes-not-allowed',
        'SKIP  google.calendar.deleted-event-gone  [write-reversible]  writes-not-allowed',
        'RUN   google.drive.list-page-token  [read]  needs --drive-folder',
        'RUN   google.drive.get-file-fields  [read]  needs --drive-file, --drive-folder',
        'SKIP  google.drive.folder-trash-delete  [write-reversible]  writes-not-allowed',
        `Use a practice Google account only, with the repository owner's approval; never in CI. Write cases ${googleRunner.writeNote}. ${googleRunner.irreversibleNote}.`
      ]
    )
  })
})

describe('run-google-conformance live refusal (no network)', () => {
  it('refuses without a token, in CI, or without the seeds of a case that would run', () => {
    expect(liveInputs(googleRunner, live(allSeedFlags), {})).toEqual({
      refusal: accessTokenRequiredMessage(googleRunner)
    })
    expect(liveInputs(googleRunner, live(allSeedFlags), { ...env, CI: '0' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(
      liveInputs(
        googleRunner,
        live(['--allow-irreversible', sendId, '--calendar=x@example.test']),
        env
      )
    ).toEqual({
      refusal:
        'Missing seed identities for the cases that would run: --paging-label, --attachment-message, --practice-address, --event-range-start, --event-range-end, --drive-folder, --drive-file'
    })
  })

  it('refuses a practice address that could name anyone else', () => {
    for (const address of [
      'Practice <practice@example.test>',
      'practice@example.test, someone@example.test',
      'practice@example.test\r\nBcc: someone@example.test'
    ]) {
      expect(
        liveInputs(
          googleRunner,
          live([
            '--allow-irreversible',
            sendId,
            ...allSeedFlags.filter(flag => !flag.startsWith('--practice-address')),
            `--practice-address=${address}`
          ]),
          env
        )
      ).toEqual({ refusal: googleRunner.invalidSeedsMessage })
    }
  })

  it('refuses a malformed token before any request, without printing it', () => {
    for (const token of [
      'token with spaces',
      'ya29.short',
      'Bearer ya29.SyntheticLiveGoogleAccessToken0001',
      'ghp_SyntheticNotAGoogleToken000000000001'
    ]) {
      const checked = liveInputs(googleRunner, live(allSeedFlags), { GOOGLE_ACCESS_TOKEN: token })

      expect(checked).toEqual({
        refusal: `GOOGLE_ACCESS_TOKEN must be ${googleRunner.tokenFormat.description}`
      })
      expect(JSON.stringify(checked)).not.toContain(token)
    }
  })

  it('generates a fresh, valid run id for every live invocation', () => {
    const runIdOf = () => {
      const checked = liveInputs(
        googleRunner,
        live(['--allow-irreversible', sendId, ...allSeedFlags]),
        env
      )

      return 'inputs' in checked ? checked.inputs.seeds.runId : expect.fail(checked.refusal)
    }

    const first = runIdOf()

    expect(first).toMatch(/^run-[0-9a-f]{8}$/)
    expect(runIdOf()).not.toBe(first)
    expect(generateRunId()).toMatch(/^run-[0-9a-f]{8}$/)
  })

  it('binds the live token as a bearer credential', () => {
    expect(liveCredential(liveToken)).toMatchObject({
      _tag: 'BearerTokenCredential',
      token: liveToken
    })
  })
})

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

describe('run-google-conformance recording headers', () => {
  it('records the content type and never the Authorization header', async () => {
    const options = recorderOptionsFor(googleRunner)

    const [exchange] = gmailNotFoundEnvelopeFixture.exchanges

    const upstream = HttpClient.make(request =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(textBody(exchange.response), {
            status: exchange.response.status,
            headers: exchange.response.headers
          })
        )
      )
    )

    const drained = await Effect.runPromise(
      Effect.gen(function* () {
        const { client, recorder } = yield* makeRecordingHttpClient(upstream, options)

        const response = yield* client.get(exchange.request.url, {
          headers: { authorization: `Bearer ${liveToken}`, accept: 'application/json' }
        })

        yield* response.text

        return yield* recorder.drain
      }).pipe(Effect.scoped)
    )

    const [recorded] = drained

    expect(recorded?.request.headers).toEqual({ accept: 'application/json' })
    expect(JSON.stringify(drained)).not.toContain(liveToken)
    expect(inspectRecordingForAccessToken(drained, liveToken)).toBe('clean')
  })
})

describe('run-google-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/google/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(googleRunner, googleConformanceFixtureSeeds)).toBe(committed)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      googleCaseSpecs.find(entry => entry.caseId === gmailLabelLifecycleFixture.caseId) ??
      expect.fail('missing label spec')

    const source = renderFixtureModule(googleRunner, spec, gmailLabelLifecycleFixture)

    expect(source).toContain('export const gmailLabelLifecycleFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:google --live --owner-approved --account <label> --record'
    )
  })

  it('advises rewriting a generated run id and lists addresses, names, and text for review', () => {
    const spec =
      googleCaseSpecs.find(entry => entry.caseId === gmailSendPracticeFixture.caseId) ??
      expect.fail('missing send spec')

    const [send, read] = gmailSendPracticeFixture.exchanges

    const recorded: WireFixture = {
      ...gmailSendPracticeFixture,
      exchanges: [
        send,
        ...(read === undefined
          ? []
          : [
              {
                ...read,
                response: {
                  status: read.response.status,
                  headers: read.response.headers,
                  body: textBody(read.response).replaceAll(
                    'practice@example.test',
                    'owner@mail.test'
                  )
                }
              }
            ])
      ]
    }

    const checklist = recordingReviewChecklist(googleRunner, [{ spec, fixture: recorded }], {
      ...googleConformanceFixtureSeeds,
      runId: 'run-0000beef'
    }).join('\n')

    expect(checklist).toContain(
      'runId="run-0000beef" is generated per run, not account data: rewrite it to "run-synthetic" in the staged fixtures and seeds.ts before promoting'
    )
    expect(checklist).toContain('emails outside example.test/example.com: "owner@mail.test"')
    expect(checklist).toContain(
      '"yolk-conformance run-synthetic send: synthetic conformance message, safe to delete"'
    )
    expect(checklist).toContain('practiceAddress="practice@example.test"')
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
    safety: googleConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs<typeof googleConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: liveToken,
  seeds: googleConformanceFixtureSeeds
}

/** Records writes in memory; nothing touches the disk. */
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

const stage = (recorders: ReadonlyMap<string, WireRecorderApi>, writer: RecordingWriter) =>
  Effect.runPromise(
    stageRecordings(googleRunner, passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir,
      recordedAt: '2026-09-30'
    }).pipe(Effect.result)
  )

/** `fixture`'s exchanges with exchange `index`'s response replaced. */
const withResponse = (
  fixture: WireFixture,
  index: number,
  response: (original: WireResponse) => WireResponse
): ReadonlyArray<WireExchange> =>
  fixture.exchanges.map((exchange, position) =>
    position === index ? { ...exchange, response: response(exchange.response) } : exchange
  )

describe('run-google-conformance --record staging (offline)', () => {
  it('stages every case under the gitignored google recordings root', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'google'))

    const { writer, files } = memoryWriter()

    const result = await stage(
      new Map(
        googleConformanceFixtures.map(fixture => [fixture.caseId, recorderOf(fixture.exchanges)])
      ),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    expect([...files.keys()].sort()).toEqual(
      [...googleCaseSpecs.map(spec => spec.fileName), 'seeds.ts']
        .map(name => join(stagingDir, name))
        .sort()
    )
    expect([...files.values()].join('\n')).not.toContain(liveToken)
  })

  const labelId = gmailLabelLifecycleFixture.caseId

  const refusal = `${labelId}: the recording still contains the live access token; nothing was written`

  for (const [label, exchanges] of [
    [
      'a token echoed in a response body',
      withResponse(gmailLabelLifecycleFixture, 0, response => ({
        status: response.status,
        headers: response.headers,
        body: textBody(response).replace('"type":"user"', `"type":"user","echo":"${liveToken}"`)
      }))
    ],
    [
      'a token echoed in a response header',
      withResponse(gmailLabelLifecycleFixture, 0, response => ({
        status: response.status,
        headers: { ...response.headers, 'x-echo': liveToken },
        body: textBody(response)
      }))
    ],
    [
      'a base64-encoded token in a body',
      withResponse(gmailLabelLifecycleFixture, 0, response => ({
        status: response.status,
        headers: response.headers,
        body: textBody(response).replace(
          '"type":"user"',
          `"type":"user","echo":"${Buffer.from(`x${liveToken}`).toString('base64')}"`
        )
      }))
    ],
    [
      'a percent-encoded token in a request URL',
      gmailLabelLifecycleFixture.exchanges.map((exchange, position) =>
        position === 0
          ? {
              ...exchange,
              request: {
                ...exchange.request,
                url: `${exchange.request.url}?echo=${encodeURIComponent(liveToken)}`
              }
            }
          : exchange
      )
    ]
  ] as const) {
    it(`writes and prints nothing for ${label}`, async () => {
      const { writer, operations } = memoryWriter()

      const result = await stage(new Map([[labelId, recorderOf(exchanges)]]), writer)

      const failure = Result.isFailure(result) ? result.failure.message : expect.fail('staged')

      expect(failure).toBe(refusal)
      expect(failure).not.toContain(liveToken)
      expect(operations).toEqual([])
    })
  }

  it('writes nothing when a recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The deleted draft is deleted again with 204: the claim no longer holds.
    const contradicted = withResponse(gmailDraftLifecycleFixture, 6, () => ({
      status: 204,
      headers: {},
      body: ''
    }))

    const result = await stage(
      new Map([[gmailDraftLifecycleFixture.caseId, recorderOf(contradicted)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${gmailDraftLifecycleFixture.caseId} did not pass on replay of its recording; nothing was written`
    )
    expect(operations).toEqual([])
  })
})

describe('run-google-conformance leftover warnings (read-only)', () => {
  const driveOnly = {
    driveFolderId: 'synthetic-practice-folder-0001',
    runId: GoogleConformanceRunId.make('run-synthetic')
  }

  const listUrl = (() => {
    const original = new URL(driveFolderLifecycleFixture.exchanges[3]?.request.url ?? '')

    original.searchParams.set('q', "'synthetic-practice-folder-0001' in parents")

    return original.toString()
  })()

  const leftovers: WireFixture = {
    id: 'google.leftovers.synthetic',
    caseId: 'google.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://www.googleapis.com/drive/v3',
    exchanges: [
      {
        request: { method: 'GET', url: listUrl },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            files: [
              JSON.parse(
                textBody(driveFolderLifecycleFixture.exchanges[1]?.response ?? expect.fail('none'))
              )
            ]
          })
        }
      }
    ]
  }

  it('warns once per leftover before a write case, even the send alone', async () => {
    for (const argv of [
      ['--allow-writes', 'reversible'],
      ['--allow-irreversible', sendId]
    ]) {
      expect(
        await Effect.runPromise(
          leftoverWarnings(
            googleRunner,
            live(argv),
            { ...recordInputs, seeds: driveOnly },
            ReplayHttpClient.layer([leftovers])
          )
        )
      ).toEqual([
        `WARN leftover from an earlier run: Drive item synthetic-conformance-folder-0001 "yolk-conformance run-synthetic folder" (in Trash); ${googleRunner.leftoverAdvice} (nothing is deleted automatically)`
      ])
    }
  })

  it('does not look when no write case would run', async () => {
    expect(
      await Effect.runPromise(
        leftoverWarnings(googleRunner, live(), recordInputs, ReplayHttpClient.layer([]))
      )
    ).toEqual([])
  })
})

describe('run-google-conformance live run wiring', () => {
  const { leftovers: _leftovers, ...withoutLookup } = googleRunner

  const sendOnly = {
    ...withoutLookup,
    cases: googleConformanceCases.filter(testCase => testCase.id === sendId)
  }

  const replayInputs = { ...recordInputs, accessToken: 'replay-access-token' }

  const runOver = async (argv: ReadonlyArray<string>) => {
    const out: Array<string> = []

    await Effect.runPromise(
      runLive(sendOnly, live(argv), replayInputs, {
        http: ReplayHttpClient.layer([gmailSendPracticeFixture]),
        out: line => {
          out.push(line)
        },
        err: () => undefined
      })
    )

    return out
  }

  it('prints the run id first when the send runs, and skips it otherwise', async () => {
    expect((await runOver(['--allow-writes', 'reversible']))[0]?.split('\n')[0]).toBe(
      `SKIP  ${sendId}  [write-irreversible]  manual-only  warnings: unverified-case`
    )
    expect(
      (await runOver(['--allow-irreversible', sendId])).join('\n').split('\n').slice(0, 2)
    ).toEqual([
      'runId for this run: run-synthetic (write-irreversible cases name it in what they leave behind)',
      `PASS  ${sendId}  [write-irreversible]  warnings: unverified-case`
    ])
  })

  it('prints no trace of the live token when every request fails', async () => {
    const lines: Array<string> = []

    await Effect.runPromise(
      runLive(
        googleRunner,
        live(['--allow-writes', 'reversible', '--allow-irreversible', sendId]),
        recordInputs,
        {
          http: ReplayHttpClient.layer([]),
          out: line => {
            lines.push(line)
          },
          err: line => {
            lines.push(line)
          }
        }
      )
    )

    const printed = lines.join('\n')

    expect(printed).toContain(`FAIL  ${sendId}`)
    expect(printed).toContain('WARN could not look for leftovers')
    expect(textContainsAccessToken(printed, liveToken)).toBe(false)
  })
})

describe('run-google-conformance printed output redacts the live token', () => {
  const labelId = gmailLabelLifecycleFixture.caseId

  const { leftovers: _leftovers, ...withoutLookup } = googleRunner

  const labelOnly = {
    ...withoutLookup,
    cases: googleConformanceCases.filter(testCase => testCase.id === labelId)
  }

  /** The label create answered with `name` (a field the case reads and reports when refused). */
  const labelAnswer = (name: string) =>
    JSON.stringify({ id: 'Label_9101', name, type: 'user', messageListVisibility: 'show' })

  /** An HTTP client answering only the label create, with `name`; `hold` delays the answer. */
  const labelClient = (name: string, hold: Promise<void> = Promise.resolve(), sent = () => {}) =>
    HttpClient.make(request =>
      Effect.gen(function* () {
        sent()
        yield* Effect.promise(() => hold)

        return HttpClientResponse.fromWeb(
          request,
          new Response(labelAnswer(name), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=UTF-8' }
          })
        )
      })
    )

  it('replaces raw, percent-encoded, and base64 forms, and withholds escaped ones', () => {
    expect(redactAccessToken(`name "${liveToken}" refused`, liveToken)).toBe(
      `name "${redactedLiveTokenMarker}" refused`
    )
    expect(redactAccessToken(`x=${encodeURIComponent(`${liveToken}/`)}`, liveToken)).not.toContain(
      liveToken
    )

    const base64 = redactAccessToken(Buffer.from(liveToken).toString('base64'), liveToken)

    expect(base64).toContain(redactedLiveTokenMarker)
    expect(textContainsAccessToken(base64, liveToken)).toBe(false)

    const escaped = liveToken.replace('.', '\\u002e')

    expect(redactAccessToken(`first\nname "${escaped}"\nlast`, liveToken)).toBe(
      `first\n${withheldTokenLine}\nlast`
    )
  })

  it('withholds a whole message whose token is folded across lines', () => {
    const base64 = Buffer.from(liveToken).toString('base64')
    const folded = (separator: string) => base64.match(/.{1,8}/g)?.join(separator) ?? ''

    for (const separator of ['\n', '\r\n']) {
      const message = `restore refused: name "${folded(separator)}" is not this run's`

      expect(message.split('\n').some(line => textContainsAccessToken(line, liveToken))).toBe(false)
      expect(redactAccessToken(message, liveToken)).toBe(withheldTokenLine)
    }

    const rawFolded = liveToken.match(/.{1,6}/g)?.join('\n') ?? ''

    // A wide fold (16+ characters per line): every full line is a fragment on its own, but the
    // short first and last pieces sit next to ordinary text; the whole message is still withheld.
    const wide = liveToken.match(/.{1,17}/g) ?? []

    expect(
      redactAccessToken(
        `start ${wide[0]}\n${wide.slice(1, -1).join('\n')}\n${wide.at(-1)} end`,
        liveToken
      )
    ).toBe(withheldTokenLine)

    expect(redactAccessToken(`name\n${rawFolded}\nend`, liveToken)).toBe(withheldTokenLine)
    // Ordinary multi-line text without the token is unchanged.
    expect(redactAccessToken('first line\nsecond line', liveToken)).toBe('first line\nsecond line')
  })

  it('withholds a line holding a cut fragment of the token (a capped report)', () => {
    const cut = `restore failed: name "${liveToken.slice(0, 20)}...`

    expect(redactAccessToken(`first\n${cut}\nlast`, liveToken)).toBe(
      `first\n${withheldTokenLine}\nlast`
    )
    // A capped base64 echo: the start of the encoded token, cut short.
    const base64Cut = Buffer.from(liveToken).toString('base64').slice(0, 28)

    expect(redactAccessToken(`name "${base64Cut}...`, liveToken)).toBe(withheldTokenLine)
    // A short shared run (under 16 characters) is not a fragment: ordinary text stays.
    expect(redactAccessToken(`token prefix ${liveToken.slice(0, 5)} only`, liveToken)).toBe(
      `token prefix ${liveToken.slice(0, 5)} only`
    )
  })

  for (const [label, name] of [
    ['raw', liveToken],
    ['base64-encoded', Buffer.from(`x${liveToken}`).toString('base64')]
  ] as const) {
    it(`prints no trace of a ${label} token echoed in a consumed field (the label name)`, async () => {
      const lines: Array<string> = []

      await Effect.runPromise(
        runLive(labelOnly, live(['--allow-writes', 'reversible']), recordInputs, {
          http: Layer.succeed(HttpClient.HttpClient, labelClient(name)),
          out: line => {
            lines.push(line)
          },
          err: line => {
            lines.push(line)
          }
        })
      )

      const printed = lines.join('\n')

      expect(printed).toContain(`FAIL  ${labelId}`)
      expect(printed).toContain('cleanup refused')
      expect(printed).toContain(redactedLiveTokenMarker)
      expect(textContainsAccessToken(printed, liveToken)).toBe(false)
    })
  }

  for (const [label, echoed] of [
    ['raw', liveToken],
    [
      'LF-folded base64',
      (
        Buffer.from(liveToken)
          .toString('base64')
          .match(/.{1,8}/g) ?? []
      ).join('\n')
    ],
    [
      'CRLF-folded base64',
      (
        Buffer.from(liveToken)
          .toString('base64')
          .match(/.{1,8}/g) ?? []
      ).join('\r\n')
    ]
  ] as const) {
    it(`prints no trace of a ${label} token when the refusal is raised during an interruption`, async () => {
      const runLines: Array<string> = []
      const cliLines: Array<string> = []

      let handlers: Array<() => void> = []

      let release = () => {}

      let markSent = () => {}

      const hold = new Promise<void>(resolvePromise => {
        release = resolvePromise
      })

      const sent = new Promise<void>(resolvePromise => {
        markSent = resolvePromise
      })

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
          cliLines.push(message)
        },
        setExitCode: () => undefined,
        forceExit: () => undefined
      }

      const done = runInterruptibly(
        runLive(labelOnly, live(['--allow-writes', 'reversible']), recordInputs, {
          http: Layer.succeed(HttpClient.HttpClient, labelClient(echoed, hold, markSent)),
          out: line => {
            runLines.push(line)
          },
          err: line => {
            runLines.push(line)
          }
        }),
        signals,
        redactingCliIo(io, liveToken),
        { now: () => 0, pid: 4242, ...interruptOptionsFor(googleRunner) }
      )

      await sent
      handlers[0]?.()
      release()
      await done

      const printed = [...runLines, ...cliLines].join('\n')

      // The case reported its refusal as a WARN line (withheld whole when the token is folded across
      // lines), and the run ended with that refusal.
      expect(
        runLines.some(
          line => line.startsWith(`WARN ${labelId}: cleanup refused`) || line === withheldTokenLine
        )
      ).toBe(true)
      expect(textContainsAccessToken(printed, liveToken)).toBe(false)

      if (label === 'raw') {
        expect(cliLines.at(-1)).toContain(`${labelId}: cleanup refused`)
        expect(cliLines.at(-1)).toContain(redactedLiveTokenMarker)
      }
    })
  }
})

describe('run-google-conformance interruption advice', () => {
  it('attempts cleanups and points at the practice account', async () => {
    expect(interruptOptionsFor(googleRunner)).toEqual({
      recoveryAdvice: googleRunner.recoveryAdvice,
      hasCleanups: true
    })

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

    const done = runInterruptibly(Effect.never, signals, io, {
      now: () => 0,
      pid: 4242,
      ...interruptOptionsFor(googleRunner)
    })

    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    handlers[0]?.()
    await done

    expect(errors[0]).toContain(
      "SIGINT: interrupting the run (pid 4242); the running case's cleanup is attempted before exit"
    )
    expect(errors.at(-1)).toBe(`Interrupted. Read the WARN lines. ${googleRunner.recoveryAdvice}`)
    expect(googleRunner.recoveryAdvice).toContain('Gmail cannot unsend')
  })
})

describe('Google fixtures and the token guard', () => {
  it('inspects every committed Google fixture as clean', () => {
    for (const fixture of googleConformanceFixtures) {
      expect(inspectRecordingForAccessToken(fixture.exchanges, liveToken)).toBe('clean')
    }
  })
})

const runCli = (argv: ReadonlyArray<string>, cliEnv: Record<string, string>) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, runnerScript, ...argv],
      { cwd: repoRoot, env: { ...process.env, ...cliEnv } },
      (error, stdout, stderr) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

describe('run-google-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { GOOGLE_ACCESS_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain(`SKIP  ${sendId}  [write-irreversible]  manual-only`)
  })

  it('refuses --live in CI before reading any token', async () => {
    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      GOOGLE_ACCESS_TOKEN: liveToken,
      CI: 'true'
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })

  it('refuses a malformed token before any request, without printing it', async () => {
    const token = 'not a google token'

    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      GOOGLE_ACCESS_TOKEN: token,
      CI: ''
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('GOOGLE_ACCESS_TOKEN must be a Google OAuth access token')
    expect(`${result.stdout}${result.stderr}`).not.toContain(token)
  })
})
