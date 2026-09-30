import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Result } from 'effect'
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
  githubCommentLifecycleFixture,
  githubConformanceCases,
  githubConformanceFixtureSeeds,
  githubConformanceFixtures,
  githubFileContentsFixture,
  githubIssueLabelsFixture,
  githubIssueLifecycleFixture,
  githubLabelsPagingFixture
} from '../../packages/connectors/src/github/conformance/index.ts'
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
  renderFixtureModule,
  renderSeedsModule,
  runInterruptibly,
  runLive,
  stageRecordings,
  textContainsAccessToken,
  usage,
  type CliIo,
  type LiveInputs,
  type RecordingWriter,
  type SignalSource
} from '../connector-conformance-internal.ts'
import {
  generateRunId,
  githubCaseSpecs,
  githubRunner,
  liveCredential,
  recordingsRoot
} from '../run-github-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-github-conformance.ts')

const lifecycleId = 'github.issues.lifecycle-close'

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(githubRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const repoFlags = ['--owner=yolk-synthetic', '--repo=conformance-practice']

const allSeedFlags = [
  ...repoFlags,
  '--work-issue=1',
  '--label=synthetic-conformance',
  '--file-path=docs/synthetic-notes.txt'
]

const liveToken = 'ghp_SyntheticLiveToken0000000000000000001'

const env = { GITHUB_TOKEN: liveToken }

describe('run-github-conformance arguments', () => {
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

  it('takes --allow-irreversible with the exact lifecycle case id only, and no run id flag', () => {
    expect(parse(['--allow-irreversible', lifecycleId])).toMatchObject({
      allowIrreversible: [lifecycleId]
    })

    for (const wrong of ['github.issues', 'github.comments.create-delete', 'all']) {
      expect(() => parse(['--allow-irreversible', wrong])).toThrow(
        `--allow-irreversible takes an exact write-irreversible case id: ${lifecycleId}`
      )
    }

    expect(() => parse(['--run-id', 'run-mine'])).toThrow('Unknown argument: --run-id')
    expect(() => parse(['--token', liveToken])).toThrow('Unknown argument: --token')
  })

  it('reads seeds from flags over env', () => {
    expect(
      parse(['--owner', 'yolk-synthetic'], {
        GITHUB_CONFORMANCE_OWNER: 'someone-else',
        GITHUB_CONFORMANCE_REPO: ' conformance-practice '
      }).seeds
    ).toEqual({ owner: 'yolk-synthetic', repo: 'conformance-practice' })
  })

  it('documents the irreversible flag with its only case id', () => {
    expect(usage(githubRunner)).toContain(`                                  ${lifecycleId}`)
    expect(usage(githubRunner)).toContain('GITHUB_TOKEN is read from the environment only')
  })
})

describe('run-github-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(githubCaseSpecs.map(spec => spec.caseId)).toEqual(
      githubConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of githubCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/github/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('runs reversible writes only when allowed and the lifecycle only by its exact id', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planRun(githubRunner, parse(argv))
        .filter(entry => entry.skipReason !== undefined)
        .map(entry => [entry.id, entry.skipReason])

    expect(skips([])).toEqual([
      ['github.comments.create-delete', 'writes-not-allowed'],
      ['github.labels.add-remove', 'writes-not-allowed'],
      [lifecycleId, 'manual-only']
    ])
    expect(skips(['--allow-writes', 'reversible'])).toEqual([[lifecycleId, 'manual-only']])
    expect(skips(['--allow-irreversible', lifecycleId])).toEqual([
      ['github.comments.create-delete', 'writes-not-allowed'],
      ['github.labels.add-remove', 'writes-not-allowed']
    ])
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    expect(dryRunReport(githubRunner, parse(['--allow-writes', 'reversible'])).split('\n')).toEqual(
      [
        'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs GITHUB_TOKEN).',
        'Plan for a live target: allowWrites=reversible, allowIrreversible=[]',
        'RUN   github.labels.list-link-paging  [read]  needs --owner, --repo',
        'RUN   github.errors.not-found-envelope  [read]  needs --owner, --repo',
        'RUN   github.errors.validation-envelope  [read]  needs --owner, --repo',
        'RUN   github.contents.base64-file  [read]  needs --owner, --repo, --file-path',
        'RUN   github.comments.create-delete  [write-reversible]  needs --owner, --repo, --work-issue',
        'RUN   github.labels.add-remove  [write-reversible]  needs --owner, --repo, --work-issue, --label',
        `SKIP  ${lifecycleId}  [write-irreversible]  manual-only`,
        `Use a practice GitHub repository only, with the repository owner's approval; never in CI. Write cases ${githubRunner.writeNote}. ${githubRunner.irreversibleNote}.`
      ]
    )
  })
})

describe('run-github-conformance live refusal (no network)', () => {
  it('refuses without a token, in CI, or without the seeds of a case that would run', () => {
    expect(liveInputs(githubRunner, live(allSeedFlags), {})).toEqual({
      refusal: accessTokenRequiredMessage(githubRunner)
    })
    expect(liveInputs(githubRunner, live(allSeedFlags), { ...env, CI: '0' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(
      liveInputs(githubRunner, live(['--allow-writes=reversible', ...repoFlags]), env)
    ).toEqual({
      refusal:
        'Missing seed identities for the cases that would run: --file-path, --work-issue, --label'
    })
    expect(liveInputs(githubRunner, live([...allSeedFlags, '--repo=..']), env)).toEqual({
      refusal: githubRunner.invalidSeedsMessage
    })
  })

  it('refuses a malformed token before any request, without printing it', () => {
    for (const token of ['token with spaces', 'short_1', `${'a'.repeat(20)}:secret`]) {
      const checked = liveInputs(githubRunner, live(allSeedFlags), { GITHUB_TOKEN: token })

      expect(checked).toEqual({
        refusal: `GITHUB_TOKEN must be ${githubRunner.tokenFormat.description}`
      })
      expect(JSON.stringify(checked)).not.toContain(token)
    }
  })

  it('generates a fresh, valid run id for every live invocation', () => {
    const runIdOf = () => {
      const checked = liveInputs(
        githubRunner,
        live(['--allow-irreversible', lifecycleId, ...allSeedFlags]),
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

describe('run-github-conformance recording headers', () => {
  it('keeps Link and the API version, and never the Authorization header', async () => {
    const options = recorderOptionsFor(githubRunner)

    expect(options.responseHeaders).toContain('link')
    expect(options.requestHeaders).toContain('x-github-api-version')

    const [page] = githubLabelsPagingFixture.exchanges

    const upstream = HttpClient.make(request =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(textBody(page.response), { status: 200, headers: page.response.headers })
        )
      )
    )

    const drained = await Effect.runPromise(
      Effect.gen(function* () {
        const { client, recorder } = yield* makeRecordingHttpClient(upstream, options)

        const response = yield* client.get(page.request.url, {
          headers: {
            authorization: `Bearer ${liveToken}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2026-03-10',
            'user-agent': 'yolk-sdk-connectors'
          }
        })

        yield* response.text

        return yield* recorder.drain
      }).pipe(Effect.scoped)
    )

    const [recorded] = drained

    expect(recorded?.request.headers).toEqual({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10'
    })
    expect(recorded?.response.headers.link).toContain('rel="next"')
    expect(inspectRecordingForAccessToken(drained, liveToken)).toBe('clean')
  })
})

describe('run-github-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/github/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(githubRunner, githubConformanceFixtureSeeds)).toBe(committed)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      githubCaseSpecs.find(entry => entry.caseId === githubLabelsPagingFixture.caseId) ??
      expect.fail('missing paging spec')

    const source = renderFixtureModule(githubRunner, spec, githubLabelsPagingFixture)

    expect(source).toContain('export const githubLabelsPagingFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:github --live --owner-approved --account <label> --record'
    )
  })

  it('advises rewriting a generated run id and lists titles and bodies for review', () => {
    const spec =
      githubCaseSpecs.find(entry => entry.caseId === githubIssueLifecycleFixture.caseId) ??
      expect.fail('missing lifecycle spec')

    const checklist = recordingReviewChecklist(
      githubRunner,
      [{ spec, fixture: githubIssueLifecycleFixture }],
      { ...githubConformanceFixtureSeeds, runId: 'run-0000beef' }
    ).join('\n')

    expect(checklist).toContain(
      'runId="run-0000beef" is generated per run, not account data: rewrite it to "run-synthetic" in the staged fixtures and seeds.ts before promoting'
    )
    expect(checklist).toContain(
      '"yolk-conformance run-synthetic lifecycle: synthetic conformance issue, safe to ignore"'
    )
    expect(checklist).toContain('"yolk-synthetic-bot"')
    expect(checklist).toContain('owner="yolk-synthetic"')
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
    safety: githubConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs<typeof githubConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: liveToken,
  seeds: githubConformanceFixtureSeeds
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
    stageRecordings(githubRunner, passedReport([...recorders.keys()]), recorders, recordInputs, {
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

describe('run-github-conformance --record staging (offline)', () => {
  it('stages every case under the gitignored github recordings root, Link headers kept', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'github'))

    const { writer, files } = memoryWriter()

    const result = await stage(
      new Map(
        githubConformanceFixtures.map(fixture => [fixture.caseId, recorderOf(fixture.exchanges)])
      ),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    expect([...files.keys()].sort()).toEqual(
      [...githubCaseSpecs.map(spec => spec.fileName), 'seeds.ts']
        .map(name => join(stagingDir, name))
        .sort()
    )
    expect(files.get(join(stagingDir, 'labels-paging.ts'))).toContain('rel=\\"next\\"')
    expect([...files.values()].join('\n')).not.toContain(liveToken)
  })

  const pagingId = githubLabelsPagingFixture.caseId

  const refusal = `${pagingId}: the recording still contains the live access token; nothing was written`

  for (const [label, exchanges] of [
    [
      'a token echoed in a response body',
      withResponse(githubLabelsPagingFixture, 0, response => ({
        status: response.status,
        headers: response.headers,
        body: textBody(response).replace('Synthetic bug label', `token ${liveToken}`)
      }))
    ],
    [
      'a token echoed in a response header',
      withResponse(githubLabelsPagingFixture, 0, response => ({
        status: response.status,
        headers: { ...response.headers, 'x-echo': liveToken },
        body: textBody(response)
      }))
    ],
    [
      'a base64-encoded token in a body',
      withResponse(githubLabelsPagingFixture, 0, response => ({
        status: response.status,
        headers: response.headers,
        body: textBody(response).replace(
          'Synthetic bug label',
          Buffer.from(`x${liveToken}`).toString('base64')
        )
      }))
    ]
  ] as const) {
    it(`writes and prints nothing for ${label}`, async () => {
      const { writer, operations } = memoryWriter()

      const result = await stage(new Map([[pagingId, recorderOf(exchanges)]]), writer)

      const failure = Result.isFailure(result) ? result.failure.message : expect.fail('staged')

      expect(failure).toBe(refusal)
      expect(failure).not.toContain(liveToken)
      expect(operations).toEqual([])
    })
  }

  it('writes nothing for a contents recording whose download_url carries a token', async () => {
    const { writer, operations } = memoryWriter()

    // A private repository's contents answer: a temporary token in download_url.
    const leaky = withResponse(githubFileContentsFixture, 0, response => ({
      status: response.status,
      headers: response.headers,
      body: textBody(response).replace(
        'docs/synthetic-notes.txt"',
        'docs/synthetic-notes.txt?token=GHSAT0AAAAAASYNTHETICDOWNLOADTOKEN"'
      )
    }))

    const result = await stage(
      new Map([[githubFileContentsFixture.caseId, recorderOf(leaky)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${githubFileContentsFixture.caseId}: recording rejected (WireFixtureSecretsFound); nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The deleted comment is deleted again with 204: the claim no longer holds.
    const contradicted = withResponse(githubCommentLifecycleFixture, 4, () => ({
      status: 204,
      headers: {},
      body: ''
    }))

    const result = await stage(
      new Map([[githubCommentLifecycleFixture.caseId, recorderOf(contradicted)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${githubCommentLifecycleFixture.caseId} did not pass on replay of its recording; nothing was written`
    )
    expect(operations).toEqual([])
  })
})

describe('run-github-conformance leftover warnings (read-only)', () => {
  const issuesUrl =
    'https://api.github.com/repos/yolk-synthetic/conformance-practice/issues?per_page=100&page=1&state=open'

  const listing = (url: string, body: string): WireExchange => ({
    request: { method: 'GET', url },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body }
  })

  const leftovers: WireFixture = {
    id: 'github.leftovers.synthetic',
    caseId: 'github.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.github.com',
    exchanges: [
      listing(
        issuesUrl,
        `[${textBody(githubIssueLifecycleFixture.exchanges[1]?.response ?? expect.fail('no issue'))}]`
      ),
      listing(
        'https://api.github.com/repos/yolk-synthetic/conformance-practice/issues/1/comments?per_page=100&page=1',
        '[]'
      ),
      listing(
        'https://api.github.com/repos/yolk-synthetic/conformance-practice/issues/1',
        textBody(githubIssueLabelsFixture.exchanges[0]?.response ?? expect.fail('no issue'))
      )
    ]
  }

  it('warns once per leftover before a write case, even the irreversible one alone', async () => {
    for (const argv of [
      ['--allow-writes', 'reversible'],
      ['--allow-irreversible', lifecycleId]
    ]) {
      expect(
        await Effect.runPromise(
          leftoverWarnings(
            githubRunner,
            live(argv),
            recordInputs,
            ReplayHttpClient.layer([leftovers])
          )
        )
      ).toEqual([
        `WARN leftover from an earlier run: open issue #42 "yolk-conformance run-synthetic lifecycle: synthetic conformance issue, safe to ignore"; ${githubRunner.leftoverAdvice} (nothing is deleted automatically)`
      ])
    }
  })

  it('does not look when no write case would run', async () => {
    expect(
      await Effect.runPromise(
        leftoverWarnings(githubRunner, live(), recordInputs, ReplayHttpClient.layer([]))
      )
    ).toEqual([])
  })
})

describe('run-github-conformance live run wiring', () => {
  const { leftovers: _leftovers, ...withoutLookup } = githubRunner

  const lifecycleOnly = {
    ...withoutLookup,
    cases: githubConformanceCases.filter(testCase => testCase.id === lifecycleId)
  }

  const replayInputs = { ...recordInputs, accessToken: 'replay-access-token' }

  const runOver = async (argv: ReadonlyArray<string>) => {
    const out: Array<string> = []

    await Effect.runPromise(
      runLive(lifecycleOnly, live(argv), replayInputs, {
        http: ReplayHttpClient.layer([githubIssueLifecycleFixture]),
        out: line => {
          out.push(line)
        },
        err: () => undefined
      })
    )

    return out
  }

  it('prints the run id first when the lifecycle runs, and skips it otherwise', async () => {
    expect((await runOver(['--allow-writes', 'reversible']))[0]?.split('\n')[0]).toBe(
      `SKIP  ${lifecycleId}  [write-irreversible]  manual-only  warnings: unverified-case`
    )
    expect(
      (await runOver(['--allow-irreversible', lifecycleId])).join('\n').split('\n').slice(0, 2)
    ).toEqual([
      'runId for this run: run-synthetic (write-irreversible cases name it in what they leave behind)',
      `PASS  ${lifecycleId}  [write-irreversible]  warnings: unverified-case`
    ])
  })

  it('prints no trace of the live token when every request fails', async () => {
    const lines: Array<string> = []

    await Effect.runPromise(
      runLive(
        githubRunner,
        live(['--allow-writes', 'reversible', '--allow-irreversible', lifecycleId]),
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

    expect(printed).toContain(`FAIL  ${lifecycleId}`)
    expect(printed).toContain('WARN could not look for leftovers')
    expect(textContainsAccessToken(printed, liveToken)).toBe(false)
  })
})

describe('run-github-conformance interruption advice', () => {
  it('attempts cleanups and points at the practice repository', async () => {
    expect(interruptOptionsFor(githubRunner)).toEqual({
      recoveryAdvice: githubRunner.recoveryAdvice,
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
      ...interruptOptionsFor(githubRunner)
    })

    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    handlers[0]?.()
    await done

    expect(errors[0]).toContain(
      "SIGINT: interrupting the run (pid 4242); the running case's cleanup is attempted before exit"
    )
    expect(errors.at(-1)).toBe(`Interrupted. Read the WARN lines. ${githubRunner.recoveryAdvice}`)
    expect(githubRunner.recoveryAdvice).toContain('GitHub issues cannot be deleted')
  })
})

describe('GitHub fixtures and the token guard', () => {
  it('inspects every committed GitHub fixture as clean', () => {
    for (const fixture of githubConformanceFixtures) {
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

describe('run-github-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { GITHUB_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain(`SKIP  ${lifecycleId}  [write-irreversible]  manual-only`)
  })

  it('refuses --live in CI before reading any token', async () => {
    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      GITHUB_TOKEN: liveToken,
      CI: 'true'
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })

  it('refuses a malformed token before any request, without printing it', async () => {
    const token = 'not a github token'

    const result = await runCli(
      ['--live', '--owner-approved', '--account', 'practice', ...repoFlags, '--file-path=a.txt'],
      { GITHUB_TOKEN: token, CI: '' }
    )

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain('GITHUB_TOKEN must be a GitHub token')
    expect(`${result.stdout}${result.stderr}`).not.toContain(token)
  })
})
