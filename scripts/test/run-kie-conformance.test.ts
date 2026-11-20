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
  kieConformanceCases,
  kieConformanceFixtureSeeds,
  kieConformanceFixtures,
  kieCreateImageTaskFixture,
  kieGetSuccessTaskFixture
} from '../../packages/connectors/src/kie/conformance/index.ts'
import {
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
  recordingRunId,
  runLive,
  stageRecordings,
  textContainsAccessToken,
  usage,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  generateRunId,
  kieCaseSpecs,
  kieRunner,
  liveCredential,
  recordingsRoot
} from '../run-kie-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-kie-conformance.ts')

const imageCaseId = 'kie.tasks.create-image-task'

const videoCaseId = 'kie.tasks.create-video-task'

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(kieRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const seedFlags = [
  '--success-task-id=yolk_synthetic_task_success_0001',
  '--failed-task-id=yolk_synthetic_task_failed_0001',
  '--first-frame-url=https://example.com/yolk-synthetic/first-frame.png'
]

const liveKey = 'synthetic-live-kie-key-0001'

describe('run-kie-conformance arguments', () => {
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

  it('takes --allow-irreversible with an exact create case id only', () => {
    expect(parse(['--allow-irreversible', imageCaseId])).toMatchObject({
      allowIrreversible: [imageCaseId]
    })
    expect(
      parse(['--allow-irreversible', imageCaseId, '--allow-irreversible', videoCaseId])
    ).toMatchObject({ allowIrreversible: [imageCaseId, videoCaseId] })

    for (const wrong of ['kie.tasks', 'kie.tasks.get-success', 'all']) {
      expect(() => parse(['--allow-irreversible', wrong])).toThrow(
        '--allow-irreversible takes an exact write-irreversible case id'
      )
    }

    expect(() => parse(['--run-id', 'run-mine'])).toThrow('Unknown argument (not shown)')
  })

  it('reads seeds from flags over env', () => {
    expect(
      parse(['--success-task-id', 'flag_task'], {
        KIE_CONFORMANCE_SUCCESS_TASK_ID: 'env_task',
        KIE_CONFORMANCE_FAILED_TASK_ID: ' failed_task '
      }).seeds
    ).toEqual({ successTaskId: 'flag_task', failedTaskId: 'failed_task' })
  })

  it('documents both create case ids for the irreversible flag', () => {
    const text = usage(kieRunner)

    expect(text).toContain(`                                  ${imageCaseId}, ${videoCaseId}`)
    expect(text).toContain('(this runner has none)')
  })
})

describe('run-kie-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(kieCaseSpecs.map(spec => spec.caseId)).toEqual(
      kieConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of kieCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/kie/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('never plans a create without its exact id, whatever --allow-writes says', () => {
    const skip = (argv: ReadonlyArray<string>, id: string) =>
      planRun(kieRunner, parse(argv)).find(entry => entry.id === id)?.skipReason

    expect(skip([], imageCaseId)).toBe('manual-only')
    expect(skip(['--allow-writes', 'reversible'], videoCaseId)).toBe('manual-only')
    expect(skip(['--allow-irreversible', imageCaseId], imageCaseId)).toBeUndefined()
    expect(skip(['--allow-irreversible', imageCaseId], videoCaseId)).toBe('manual-only')
  })

  it('prints a dry-run plan that says a create cannot be undone', () => {
    expect(dryRunReport(kieRunner, parse([])).split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs KIE_API_KEY).',
      'Plan for a live target: allowWrites=none, allowIrreversible=[]',
      'RUN   kie.tasks.get-success  [read]  needs --success-task-id',
      'RUN   kie.tasks.get-failed  [read]  needs --failed-task-id',
      'RUN   kie.errors.task-not-found  [read]',
      'RUN   kie.errors.unauthorized  [read]',
      'SKIP  kie.tasks.create-image-task  [write-irreversible]  manual-only',
      'SKIP  kie.tasks.create-video-task  [write-irreversible]  manual-only',
      `Use a practice Kie account with a small credit balance only, with the repository owner's approval; never in CI. ${kieRunner.irreversibleNote}.`
    ])
  })
})

const recordInputs: LiveInputs<typeof kieConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: liveKey,
  seeds: kieConformanceFixtureSeeds
}

describe('run-kie-conformance live refusal (no network)', () => {
  const env = { KIE_API_KEY: liveKey }

  it('refuses without a key, with a malformed key, or without the seeds of a case that would run', () => {
    expect(liveInputs(kieRunner, live(seedFlags), {})).toEqual({
      refusal: 'KIE_API_KEY is required for --live'
    })
    expect(liveInputs(kieRunner, live(seedFlags), { KIE_API_KEY: 'short' })).toEqual({
      refusal: 'KIE_API_KEY must be 16 to 256 letters, digits, _ or -'
    })
    expect(liveInputs(kieRunner, live(['--failed-task-id=x_task']), env)).toEqual({
      refusal: 'Missing seed identities for the cases that would run: --success-task-id'
    })
    expect(
      liveInputs(
        kieRunner,
        live([...seedFlags, '--first-frame-url=http://example.com/frame.png']),
        env
      )
    ).toEqual({ refusal: kieRunner.invalidSeedsMessage })
  })

  it('needs the first frame only when the video create would run', () => {
    const readsOnly = liveInputs(kieRunner, live(seedFlags.slice(0, 2)), env)

    expect('inputs' in readsOnly).toBe(true)
    expect(
      liveInputs(
        kieRunner,
        live([...seedFlags.slice(0, 2), '--allow-irreversible', videoCaseId]),
        env
      )
    ).toEqual({
      refusal: 'Missing seed identities for the cases that would run: --first-frame-url'
    })
  })

  it('generates a fresh run id for every invocation, for the create prompts', () => {
    const runIdOf = () => {
      const checked = liveInputs(
        kieRunner,
        live(['--allow-irreversible', imageCaseId, ...seedFlags]),
        env
      )

      return 'inputs' in checked ? checked.inputs.seeds.runId : expect.fail(checked.refusal)
    }

    const first = runIdOf()

    expect(first).toMatch(/^run-[0-9a-f]{8}$/)
    expect(runIdOf()).not.toBe(first)
    expect(generateRunId()).toMatch(/^run-[0-9a-f]{8}$/)
  })

  it('binds the live key as an API key credential for the kie.api_key slot', () => {
    expect(liveCredential(liveKey)).toMatchObject({ _tag: 'ApiKeyCredential', key: liveKey })
  })

  it('has no leftover lookup and no cleanup: a created task is never cancelled', async () => {
    expect(kieRunner).not.toHaveProperty('leftovers')
    expect(interruptOptionsFor(kieRunner)).toEqual({
      recoveryAdvice: kieRunner.recoveryAdvice,
      hasCleanups: false
    })
    expect(
      await Effect.runPromise(
        leftoverWarnings(
          kieRunner,
          live(['--allow-irreversible', imageCaseId]),
          recordInputs,
          ReplayHttpClient.layer([])
        )
      )
    ).toEqual([])
  })
})

describe('run-kie-conformance live run wiring', () => {
  it('prints no trace of the live key when every request fails', async () => {
    const out: Array<string> = []
    const err: Array<string> = []

    await Effect.runPromise(
      runLive(
        kieRunner,
        live(['--allow-irreversible', imageCaseId, '--allow-irreversible', videoCaseId]),
        recordInputs,
        {
          http: ReplayHttpClient.layer([]),
          out: line => {
            out.push(line)
          },
          err: line => {
            err.push(line)
          }
        }
      )
    )

    const printed = [...out, ...err].join('\n')

    expect(printed).toContain(`FAIL  ${imageCaseId}`)
    expect(printed).toContain('task outcome unknown')
    expect(textContainsAccessToken(printed, liveKey)).toBe(false)
  })

  it('runs both creates on the committed fixtures once both are named', async () => {
    const out: Array<string> = []

    // One replay serves every case: the not-found and unauthorized reads share one URL, so the
    // not-found fixture is left out and its case meets the recorded 401 instead.
    const fixtures = kieConformanceFixtures.filter(
      fixture => fixture.caseId !== 'kie.errors.task-not-found'
    )

    await Effect.runPromise(
      runLive(
        kieRunner,
        live(['--allow-irreversible', imageCaseId, '--allow-irreversible', videoCaseId]),
        { ...recordInputs, seeds: kieConformanceFixtureSeeds },
        {
          http: ReplayHttpClient.layer(fixtures),
          out: line => {
            out.push(line)
          },
          err: () => undefined
        }
      )
    )

    expect(out[0]).toBe(
      'runId for this run: run-synthetic (write-irreversible cases name it in what they leave behind)'
    )

    const results = out
      .join('\n')
      .split('\n')
      .filter(line => /^(?:PASS|FAIL) /.test(line))
      .map(line => line.split('  ').slice(0, 2).join(' '))

    expect(results).toEqual([
      'PASS kie.tasks.get-success',
      'PASS kie.tasks.get-failed',
      'FAIL kie.errors.task-not-found',
      'PASS kie.errors.unauthorized',
      `PASS ${imageCaseId}`,
      `PASS ${videoCaseId}`
    ])
  })
})

const recorderOf = (exchanges: ReadonlyArray<WireExchange>): WireRecorderApi => ({
  drain: Effect.succeed(exchanges)
})

const passedReport = (caseIds: ReadonlyArray<string>): ConformanceReport => ({
  target: { kind: 'live', account: 'practice' },
  startedAt: '2026-11-20T12:00:00.000Z',
  results: caseIds.map(id => ({
    id,
    safety: kieConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
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
  recordingRunId(new Date('2026-11-20T12:34:56.789Z'), 'a1b2c3d4')
)

const stageWith = (recorders: ReadonlyMap<string, WireRecorderApi>, writer: RecordingWriter) =>
  Effect.runPromise(
    stageRecordings(kieRunner, passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir,
      recordedAt: '2026-11-20'
    }).pipe(Effect.result)
  )

describe('run-kie-conformance --record staging (offline)', () => {
  it('stages every recording, lists prompts and task ids for review', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'kie'))

    const { writer, files } = memoryWriter()

    const result = await stageWith(
      new Map(
        kieConformanceFixtures.map(
          fixture => [fixture.caseId, recorderOf(fixture.exchanges)] as const
        )
      ),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail(Result.isFailure(result) ? result.failure.message : 'nothing staged')
    }

    expect([...files.keys()].sort()).toEqual(
      [...kieCaseSpecs.map(spec => spec.fileName), 'seeds.ts']
        .sort()
        .map(name => join(stagingDir, name))
    )
    expect([...files.values()].join('\n')).not.toContain(liveKey)

    const checklist = result.success.checklist.join('\n')

    expect(checklist).toContain('"yolk_synthetic_task_success_0001"')
    expect(checklist).toContain(
      '"yolk-conformance run-synthetic: a plain grey square, synthetic conformance test, safe to ignore"'
    )
    expect(checklist).toContain('https://tempfile.example.com/yolk-synthetic/image-0001.png')
  })

  it('writes nothing when a recording carries the live key', async () => {
    const { writer, operations } = memoryWriter()

    const leaky = kieGetSuccessTaskFixture.exchanges.map(exchange => ({
      ...exchange,
      response: {
        status: exchange.response.status,
        headers: exchange.response.headers,
        body: `{"echo":"${liveKey}"}`
      }
    }))

    const result = await stageWith(
      new Map([[kieGetSuccessTaskFixture.caseId, recorderOf(leaky)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${kieGetSuccessTaskFixture.caseId}: the recording still contains the live access token; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('inspects every committed Kie fixture as clean', () => {
    for (const fixture of kieConformanceFixtures) {
      expect(inspectRecordingForAccessToken(fixture.exchanges, liveKey)).toBe('clean')
    }

    expect(kieCreateImageTaskFixture.exchanges[0]?.request.headers).not.toHaveProperty(
      'authorization'
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

describe('run-kie-conformance CLI', () => {
  it('dry-runs by default without a key', async () => {
    const result = await runCli([], { KIE_API_KEY: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain(`SKIP  ${imageCaseId}  [write-irreversible]  manual-only`)
  })

  it('refuses an irreversible id that is not exact', async () => {
    const result = await runCli(['--allow-irreversible', 'kie.tasks'], { KIE_API_KEY: '', CI: '' })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(
      '--allow-irreversible takes an exact write-irreversible case id'
    )
  })
})
