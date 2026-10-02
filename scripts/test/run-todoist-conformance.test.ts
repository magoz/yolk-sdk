import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  todoistConformanceCases,
  todoistConformanceFixtureSeeds,
  todoistTaskLifecycleFixture,
  todoistTasksPagingFixture
} from '../../packages/connectors/src/todoist/conformance/index.ts'
import {
  accessTokenRequiredMessage,
  defaultRunOptions,
  dryRunReport,
  leftoverWarnings,
  liveInCiMessage,
  liveInputs,
  liveTarget,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  planRun,
  recordingReviewChecklist,
  recordingRunId,
  renderFixtureModule,
  renderSeedsModule,
  stageRecordings,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  generateRunId,
  liveCredential,
  recordingsRoot,
  todoistCaseSpecs,
  todoistRunner
} from '../run-todoist-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-todoist-conformance.ts')

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(todoistRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const readSeedFlags = ['--paging-project=6XSyntheticPage0', '--labeled-task=6XSyntheticLabel']

describe('run-todoist-conformance arguments', () => {
  it('defaults to a dry run with no writes and requires CI empty, approval, and an account', () => {
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
    expect(live()).toMatchObject({ live: true, ownerApproved: true, account: 'practice' })
  })

  it('reads seeds from flags over env', () => {
    expect(
      parse(['--work-project', '6XSyntheticWork0'], {
        TODOIST_CONFORMANCE_WORK_PROJECT: '6XSyntheticElse0',
        TODOIST_CONFORMANCE_PAGING_PROJECT: ' 6XSyntheticPage0 '
      }).seeds
    ).toEqual({ workProjectId: '6XSyntheticWork0', pagingProjectId: '6XSyntheticPage0' })
  })

  it('rejects an irreversible flag and a run id flag: Todoist has neither', () => {
    expect(() => parse(['--allow-irreversible', 'todoist.tasks.lifecycle-close'])).toThrow(
      'Unknown argument (not shown)'
    )
    expect(() => parse(['--run-id', 'run-mine'])).toThrow('Unknown argument (not shown)')
    expect(todoistConformanceCases.some(testCase => testCase.safety === 'write-irreversible')).toBe(
      false
    )
  })
})

describe('run-todoist-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(todoistCaseSpecs.map(spec => spec.caseId)).toEqual(
      todoistConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of todoistCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/todoist/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('runs only read cases by default and every case with reversible writes', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planRun(todoistRunner, parse(argv)).map(entry => [entry.id, entry.skipReason ?? 'runs'])

    expect(skips([]).filter(([, skip]) => skip !== 'runs')).toEqual([
      ['todoist.tasks.lifecycle-close', 'writes-not-allowed'],
      ['todoist.tasks.due-dates', 'writes-not-allowed'],
      ['todoist.projects.parent-id', 'writes-not-allowed'],
      ['todoist.projects.delete-then-not-found', 'writes-not-allowed']
    ])
    expect(skips(['--allow-writes', 'reversible']).every(([, skip]) => skip === 'runs')).toBe(true)
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    expect(dryRunReport(todoistRunner, parse([])).split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs TODOIST_API_TOKEN).',
      'Plan for a live target: allowWrites=none',
      'RUN   todoist.tasks.list-cursor-paging  [read]  needs --paging-project',
      'RUN   todoist.errors.not-found-envelope  [read]',
      'RUN   todoist.labels.task-labels-are-names  [read]  needs --labeled-task',
      'SKIP  todoist.tasks.lifecycle-close  [write-reversible]  writes-not-allowed',
      'SKIP  todoist.tasks.due-dates  [write-reversible]  writes-not-allowed',
      'SKIP  todoist.projects.parent-id  [write-reversible]  writes-not-allowed',
      'SKIP  todoist.projects.delete-then-not-found  [write-reversible]  writes-not-allowed',
      "Use a practice Todoist account only, with the repository owner's approval; never in CI. Write cases create their own yolk-conformance-<run id> project under --work-project (a fresh random run id per invocation) and delete it again by id."
    ])
  })
})

describe('run-todoist-conformance live refusal (no network)', () => {
  const env = { TODOIST_API_TOKEN: 'synthetic-token' }

  it('refuses without a token, in CI, or without the seeds of a case that would run', () => {
    expect(liveInputs(todoistRunner, live(readSeedFlags), {})).toEqual({
      refusal: accessTokenRequiredMessage(todoistRunner)
    })
    expect(liveInputs(todoistRunner, live(readSeedFlags), { ...env, CI: '0' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(
      liveInputs(todoistRunner, live(['--allow-writes=reversible', ...readSeedFlags]), env)
    ).toEqual({ refusal: 'Missing seed identities for the cases that would run: --work-project' })
    expect(
      liveInputs(todoistRunner, live([...readSeedFlags, '--work-project=not an id']), env)
    ).toEqual({ refusal: todoistRunner.invalidSeedsMessage })
  })

  it('generates a fresh, valid run id for every live invocation', () => {
    const runIdOf = () => {
      const checked = liveInputs(
        todoistRunner,
        live(['--allow-writes=reversible', '--work-project=6XSyntheticWork0', ...readSeedFlags]),
        env
      )

      return 'inputs' in checked ? checked.inputs.seeds.runId : expect.fail(checked.refusal)
    }

    const first = runIdOf()

    expect(first).toMatch(/^run-[0-9a-f]{8}$/)
    expect(runIdOf()).not.toBe(first)
    expect(generateRunId()).toMatch(/^run-[0-9a-f]{8}$/)
  })

  it('binds the live token as an API key credential', () => {
    expect(liveCredential('synthetic-token')).toMatchObject({
      _tag: 'ApiKeyCredential',
      key: 'synthetic-token'
    })
  })
})

describe('run-todoist-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/todoist/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(todoistRunner, todoistConformanceFixtureSeeds)).toBe(committed)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      todoistCaseSpecs.find(entry => entry.caseId === todoistTasksPagingFixture.caseId) ??
      expect.fail('missing paging spec')

    const source = renderFixtureModule(todoistRunner, spec, todoistTasksPagingFixture)

    expect(source).toContain('export const todoistTasksPagingFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:todoist --live --owner-approved --account <label> --record'
    )
  })

  it('advises rewriting a generated run id to the committed synthetic one', () => {
    const spec =
      todoistCaseSpecs.find(entry => entry.caseId === todoistTaskLifecycleFixture.caseId) ??
      expect.fail('missing lifecycle spec')

    const checklist = recordingReviewChecklist(
      todoistRunner,
      [{ spec, fixture: todoistTaskLifecycleFixture }],
      { ...todoistConformanceFixtureSeeds, runId: 'run-0000beef' }
    ).join('\n')

    expect(checklist).toContain(
      'runId="run-0000beef" is generated per run, not account data: rewrite it to "run-synthetic" in the staged fixtures and seeds.ts before promoting'
    )
    // Project names and task text are listed for review.
    expect(checklist).toContain('"yolk-conformance-run-synthetic-lifecycle"')
    expect(checklist).toContain('text: "yolk-conformance task: safe to delete"')
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
    safety: todoistConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs<typeof todoistConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: 'synthetic-token',
  seeds: todoistConformanceFixtureSeeds
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
    stageRecordings(todoistRunner, passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir,
      recordedAt: '2026-09-30'
    }).pipe(Effect.result)
  )

describe('run-todoist-conformance --record staging (offline)', () => {
  it('stages a read and a write recording under the gitignored todoist recordings root', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'todoist'))

    const { writer, files } = memoryWriter()

    const result = await stage(
      new Map([
        [todoistTasksPagingFixture.caseId, recorderOf(todoistTasksPagingFixture.exchanges)],
        [todoistTaskLifecycleFixture.caseId, recorderOf(todoistTaskLifecycleFixture.exchanges)]
      ]),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail('expected staged recordings')
    }

    expect([...files.keys()].sort()).toEqual(
      [
        join(stagingDir, 'seeds.ts'),
        join(stagingDir, 'tasks-paging.ts'),
        join(stagingDir, 'task-lifecycle.ts')
      ].sort()
    )
    expect(files.get(join(stagingDir, 'tasks-paging.ts'))).toContain('"evidence": "verified"')
    expect(files.get(join(stagingDir, 'seeds.ts'))).toBe(
      renderSeedsModule(todoistRunner, todoistConformanceFixtureSeeds)
    )
  })

  it('writes nothing when a recording contains the live access token', async () => {
    const { writer, operations } = memoryWriter()

    const [first, ...rest] = todoistTasksPagingFixture.exchanges

    // A response that echoes the token somewhere the secret scan does not look.
    const leaky: ReadonlyArray<WireExchange> = [
      {
        ...first,
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: textBody(first.response).replace('SyntheticTaskCursor0001', 'synthetic-token')
        }
      },
      ...rest
    ]

    const result = await stage(
      new Map([[todoistTasksPagingFixture.caseId, recorderOf(leaky)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${todoistTasksPagingFixture.caseId}: the recording still contains the live access token; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The closed task is still listed as active: the claim no longer holds.
    const contradicted = todoistTaskLifecycleFixture.exchanges.map((exchange, index) =>
      index === 5 &&
      !isWireStreamResponse(exchange.response) &&
      !isWireBase64BodyResponse(exchange.response)
        ? {
            ...exchange,
            response: {
              ...exchange.response,
              body: `{"results":[${textBody(todoistTaskLifecycleFixture.exchanges[2]?.response ?? exchange.response)}],"next_cursor":null}`
            }
          }
        : exchange
    )

    const result = await stage(
      new Map([[todoistTaskLifecycleFixture.caseId, recorderOf(contradicted)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${todoistTaskLifecycleFixture.caseId} did not pass on replay of its recording; nothing was written`
    )
    expect(operations).toEqual([])
  })
})

function textBody(response: WireExchange['response']): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

describe('run-todoist-conformance leftover warnings (read-only)', () => {
  const listing: WireFixture = {
    id: 'todoist.leftovers.synthetic',
    caseId: 'todoist.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.todoist.com/api/v1',
    exchanges: [
      {
        request: { method: 'GET', url: 'https://api.todoist.com/api/v1/projects?limit=200' },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"results":[{"id":"6XSynLeftover001","name":"yolk-conformance-run-0000beef-due","parent_id":"6XSyntheticWork0"},{"id":"6XSynKeepMe00001","name":"Keep Me"}],"next_cursor":null}'
        }
      }
    ]
  }

  const writesOptions = live(['--allow-writes', 'reversible'])

  it('warns once per leftover before any write case and never deletes', async () => {
    expect(
      await Effect.runPromise(
        leftoverWarnings(
          todoistRunner,
          writesOptions,
          recordInputs,
          ReplayHttpClient.layer([listing])
        )
      )
    ).toEqual([
      'WARN leftover from an earlier run: yolk-conformance-run-0000beef-due (6XSynLeftover001); delete it by hand after checking that no run is still using it (nothing is deleted automatically)'
    ])
  })

  it('does not look when no write case would run', async () => {
    expect(
      await Effect.runPromise(
        leftoverWarnings(todoistRunner, live(), recordInputs, ReplayHttpClient.layer([]))
      )
    ).toEqual([])
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

describe('run-todoist-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { TODOIST_API_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain(
      'SKIP  todoist.tasks.lifecycle-close  [write-reversible]  writes-not-allowed'
    )
  })

  it('refuses --live in CI before reading any token', async () => {
    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      TODOIST_API_TOKEN: 'synthetic-token',
      CI: 'true'
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })
})
