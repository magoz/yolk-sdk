import { execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Deferred, Effect, Result } from 'effect'
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
  dropboxConformanceCases,
  dropboxConformanceFixtureSeeds,
  dropboxCreateFolderConflictFixture,
  dropboxListFolderPagingFixture,
  dropboxPathLowerLookupFixture
} from '../../packages/connectors/src/dropbox/conformance/index.ts'
import {
  accessTokenRequiredMessage,
  defaultRunOptions,
  dryRunReport,
  liveAccountRequiredMessage,
  liveInCiMessage,
  liveInputs,
  liveTarget,
  mergedFixtureSeeds,
  nodeRecordingWriter,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  physicallyContained,
  planRun,
  recordingReviewChecklist,
  recordingRunId,
  renderFixtureModule,
  renderSeedsModule,
  stageRecordings,
  staleSharedSeeds,
  leftoverWarnings,
  runInterruptibly,
  type CliIo,
  type CliSignal,
  type LiveInputs,
  type RecordingWriter,
  type SignalSource
} from '../connector-conformance-internal.ts'
import {
  dropboxCaseSpecs,
  dropboxRunner,
  generateRunId,
  liveCredential,
  recordingsRoot
} from '../run-dropbox-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-dropbox-conformance.ts')

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(dropboxRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const readSeedFlags = [
  '--paging-folder=/Conformance/Paging',
  '--mixed-case-path=/Conformance/Mixed Case Notes.txt',
  '--search-query=yolk-search-probe',
  '--work-folder=/Conformance/Work'
]

describe('run-dropbox-conformance arguments', () => {
  it('defaults to a dry run with no writes, no approval, no account, and no seeds', () => {
    expect(parse([])).toEqual(defaultRunOptions)
    expect(liveTarget(defaultRunOptions)).toEqual({
      kind: 'live',
      account: 'dry-run',
      allowWrites: 'none',
      allowIrreversible: []
    })
  })

  it('requires --owner-approved and a synthetic --account label with --live', () => {
    expect(() => parse(['--live', '--account', 'practice'])).toThrow(ownerApprovalRequiredMessage)
    expect(() => parse(['--live', '--owner-approved'])).toThrow(liveAccountRequiredMessage)
    expect(() => parse(['--live', '--owner-approved', '--account', 'Example Person'])).toThrow(
      '--account must be a short synthetic label'
    )
    expect(live()).toMatchObject({ live: true, ownerApproved: true, account: 'practice' })
    expect(parse(['--live', '--help']).help).toBe(true)
  })

  it('refuses --live whenever CI is non-empty, 0 and false included', () => {
    for (const value of ['1', 'true', '0', 'false']) {
      expect(() =>
        parse(['--live', '--owner-approved', '--account', 'practice'], { CI: value })
      ).toThrow(liveInCiMessage)
    }

    expect(parse(['--live', '--owner-approved', '--account', 'practice'], { CI: '' }).live).toBe(
      true
    )
    // A dry run in CI is fine: it makes no request and reads no credential.
    expect(parse([], { CI: 'true' }).live).toBe(false)
  })

  it('reads write policy, record, and seeds from flags over env', () => {
    const options = parse(
      [
        '--live',
        '--owner-approved',
        '--account=practice',
        '--allow-writes',
        'reversible',
        '--record',
        '--work-folder',
        '/Conformance/Work'
      ],
      {
        DROPBOX_CONFORMANCE_WORK_FOLDER: '/Elsewhere',
        DROPBOX_CONFORMANCE_COPY_SOURCE: ' /Conformance/copy-source.txt ',
        DROPBOX_CONFORMANCE_SEARCH_QUERY: ''
      }
    )

    expect(options).toEqual({
      live: true,
      help: false,
      record: true,
      ownerApproved: true,
      account: 'practice',
      allowWrites: 'reversible',
      seeds: { workFolderPath: '/Conformance/Work', copySourcePath: '/Conformance/copy-source.txt' }
    })
  })

  it('rejects unknown flags, bad values, irreversible flags, and --record without --live', () => {
    expect(() => parse(['--nope'])).toThrow('Unknown argument')
    expect(() => parse(['--work-folder'])).toThrow('requires a value')
    expect(() => parse(['--allow-writes=all'])).toThrow('none or reversible')
    expect(() => parse(['--allow-irreversible', 'dropbox.files.upload-rev-precondition'])).toThrow(
      'Unknown argument'
    )
    expect(() => parse(['--record'])).toThrow('--record requires --live')
    // The run id is generated per invocation, never supplied.
    expect(() => parse(['--run-id', 'run-mine'])).toThrow('Unknown argument')
  })
})

describe('run-dropbox-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(dropboxCaseSpecs.map(spec => spec.caseId)).toEqual(
      dropboxConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of dropboxCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/dropbox/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('runs only read cases by default and every case with reversible writes', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planRun(dropboxRunner, parse(argv)).map(entry => [entry.id, entry.skipReason ?? 'runs'])

    expect(skips([])).toEqual([
      ['dropbox.files.list-folder-cursor-paging', 'runs'],
      ['dropbox.files.path-lower-lookup', 'runs'],
      ['dropbox.files.search-continue', 'runs'],
      ['dropbox.errors.not-found-409-envelope', 'runs'],
      ['dropbox.files.create-folder-conflict', 'writes-not-allowed'],
      ['dropbox.files.delete-then-not-found', 'writes-not-allowed'],
      ['dropbox.files.copy-move-metadata', 'writes-not-allowed'],
      ['dropbox.files.upload-rev-precondition', 'writes-not-allowed']
    ])
    expect(skips(['--allow-writes', 'reversible']).every(([, skip]) => skip === 'runs')).toBe(true)
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    expect(
      dryRunReport(dropboxRunner, parse(['--allow-writes', 'reversible'])).split('\n')
    ).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs DROPBOX_ACCESS_TOKEN).',
      'Plan for a live target: allowWrites=reversible',
      'RUN   dropbox.files.list-folder-cursor-paging  [read]  needs --paging-folder',
      'RUN   dropbox.files.path-lower-lookup  [read]  needs --mixed-case-path',
      'RUN   dropbox.files.search-continue  [read]  needs --search-query',
      'RUN   dropbox.errors.not-found-409-envelope  [read]  needs --work-folder',
      'RUN   dropbox.files.create-folder-conflict  [write-reversible]  needs --work-folder',
      'RUN   dropbox.files.delete-then-not-found  [write-reversible]  needs --work-folder',
      'RUN   dropbox.files.copy-move-metadata  [write-reversible]  needs --work-folder, --copy-source',
      'RUN   dropbox.files.upload-rev-precondition  [write-reversible]  needs --work-folder',
      "Use a practice Dropbox account only, with the repository owner's approval; never in CI. Write cases work inside their own yolk-conformance-<run id> folder under --work-folder (a fresh random run id per invocation) and delete it again."
    ])
  })
})

describe('run-dropbox-conformance live refusal (no network)', () => {
  const env = { DROPBOX_ACCESS_TOKEN: 'synthetic-token' }

  it('refuses in CI, without approval, an account, or an access token', () => {
    expect(liveInputs(dropboxRunner, live(readSeedFlags), { ...env, CI: '1' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(
      liveInputs(dropboxRunner, { ...live(readSeedFlags), ownerApproved: false }, env)
    ).toEqual({ refusal: ownerApprovalRequiredMessage })
    expect(
      liveInputs(
        dropboxRunner,
        { ...defaultRunOptions, live: true, ownerApproved: true, seeds: {} },
        env
      )
    ).toEqual({ refusal: liveAccountRequiredMessage })
    expect(liveInputs(dropboxRunner, live(readSeedFlags), {})).toEqual({
      refusal: accessTokenRequiredMessage(dropboxRunner)
    })
    expect(liveInputs(dropboxRunner, live(readSeedFlags), { DROPBOX_ACCESS_TOKEN: '  ' })).toEqual({
      refusal: 'DROPBOX_ACCESS_TOKEN is required for --live'
    })
  })

  it('refuses when a case that would run lacks its seed or a seed is invalid', () => {
    expect(liveInputs(dropboxRunner, live(), env)).toEqual({
      refusal:
        'Missing seed identities for the cases that would run: --paging-folder, --mixed-case-path, --search-query, --work-folder'
    })
    expect(
      liveInputs(dropboxRunner, live(['--allow-writes', 'reversible', ...readSeedFlags]), env)
    ).toEqual({ refusal: 'Missing seed identities for the cases that would run: --copy-source' })
    expect(
      liveInputs(dropboxRunner, live([...readSeedFlags, '--work-folder=Conformance/Work/']), env)
    ).toEqual({ refusal: dropboxRunner.invalidSeedsMessage })
    expect(
      liveInputs(dropboxRunner, live(readSeedFlags), env, { runId: 'run-0000beef' })
    ).toMatchObject({
      inputs: {
        account: 'practice',
        accessToken: 'synthetic-token',
        seeds: {
          workFolderPath: '/Conformance/Work',
          searchQuery: 'yolk-search-probe',
          runId: 'run-0000beef'
        }
      }
    })
  })

  it('generates a fresh, valid run id for every live invocation', () => {
    const runIdOf = () => {
      const checked = liveInputs(dropboxRunner, live(readSeedFlags), env)

      return 'inputs' in checked ? checked.inputs.seeds.runId : expect.fail(checked.refusal)
    }

    const first = runIdOf()
    const second = runIdOf()

    expect(first).toMatch(/^run-[0-9a-f]{8}$/)
    expect(second).toMatch(/^run-[0-9a-f]{8}$/)
    expect(first).not.toBe(second)
    expect(generateRunId()).toMatch(/^run-[0-9a-f]{8}$/)
  })

  it('binds the live token as a bearer credential', () => {
    expect(liveCredential('synthetic-token')).toMatchObject({
      _tag: 'BearerTokenCredential',
      token: 'synthetic-token'
    })
  })
})

describe('run-dropbox-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/dropbox/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(dropboxRunner, dropboxConformanceFixtureSeeds)).toBe(committed)
  })

  it('merges the seeds of recorded cases only and flags shared seeds that changed', () => {
    const merged = mergedFixtureSeeds(
      dropboxRunner,
      dropboxConformanceFixtureSeeds,
      { workFolderPath: '/Practice/Work', runId: 'run-0000beef' },
      ['dropbox.files.create-folder-conflict']
    )

    expect(merged).toEqual({
      ...dropboxConformanceFixtureSeeds,
      workFolderPath: '/Practice/Work',
      runId: 'run-0000beef'
    })
    expect(
      staleSharedSeeds(dropboxRunner, dropboxConformanceFixtureSeeds, merged, [
        'dropbox.files.create-folder-conflict'
      ])
    ).toEqual([
      {
        key: 'workFolderPath',
        cases: [
          'dropbox.errors.not-found-409-envelope',
          'dropbox.files.delete-then-not-found',
          'dropbox.files.copy-move-metadata',
          'dropbox.files.upload-rev-precondition'
        ]
      }
    ])
  })

  it('advises rewriting a generated run id to the committed synthetic one, not keeping it', () => {
    const spec =
      dropboxCaseSpecs.find(entry => entry.caseId === dropboxCreateFolderConflictFixture.caseId) ??
      expect.fail('missing conflict spec')

    const checklist = recordingReviewChecklist(
      dropboxRunner,
      [{ spec, fixture: dropboxCreateFolderConflictFixture }],
      { ...dropboxConformanceFixtureSeeds, runId: 'run-0000beef' }
    ).join('\n')

    expect(checklist).toContain(
      'runId="run-0000beef" is generated per run, not account data: rewrite it to "run-synthetic" in the staged fixtures and seeds.ts before promoting'
    )
    expect(checklist).toContain(
      'seeds.ts: every account seed names practice-account data; replace each with a synthetic value'
    )
    expect(checklist).not.toContain('runId="run-0000beef",')
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      dropboxCaseSpecs.find(entry => entry.caseId === dropboxListFolderPagingFixture.caseId) ??
      expect.fail('missing paging spec')

    const source = renderFixtureModule(dropboxRunner, spec, dropboxListFolderPagingFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const dropboxListFolderPagingFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:dropbox --live --owner-approved --account <label> --record'
    )
  })
})

// Offline `--record` gate: fake recorders hand back synthetic exchanges; an in-memory writer stands
// in for the filesystem. Nothing touches the disk or the network.

const recorderOf = (exchanges: ReadonlyArray<WireExchange>): WireRecorderApi => ({
  drain: Effect.succeed(exchanges)
})

const passedReport = (caseIds: ReadonlyArray<string>): ConformanceReport => ({
  target: { kind: 'live', account: 'practice' },
  startedAt: '2026-09-30T12:00:00.000Z',
  results: caseIds.map(id => ({
    id,
    safety: dropboxConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs<typeof dropboxConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: 'synthetic-token',
  seeds: dropboxConformanceFixtureSeeds
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

const memoryWriter = (
  faults: { readonly failOnWrite?: number; readonly failRename?: boolean } = {}
) => {
  const directories = new Set<string>()
  const files = new Map<string, string>()
  const operations: Array<string> = []
  let writeCount = 0

  const writer: RecordingWriter = {
    exists: path => directories.has(path) || files.has(path),
    mkdir: path => {
      operations.push(`mkdir ${path}`)

      for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) directories.add(dir)
    },
    writeFile: (path, contents) => {
      operations.push(`write ${path}`)

      if (writeCount++ === faults.failOnWrite) throw new Error('synthetic write failure')

      if (!directories.has(dirname(path)) || files.has(path)) throw new Error('synthetic EEXIST')

      files.set(path, contents)
    },
    rename: (from, to) => {
      operations.push(`rename ${from} -> ${to}`)

      if (faults.failRename === true || directories.has(to))
        throw new Error('synthetic rename failure')

      for (const dir of [...directories].filter(dir => isUnder(dir, from))) {
        directories.delete(dir)
        directories.add(to + dir.slice(from.length))
      }

      for (const [path, contents] of [...files].filter(([path]) => isUnder(path, from))) {
        files.delete(path)
        files.set(to + path.slice(from.length), contents)
      }
    },
    rm: path => {
      operations.push(`rm ${path}`)

      for (const dir of [...directories].filter(dir => isUnder(dir, path))) directories.delete(dir)

      for (const file of [...files.keys()].filter(file => isUnder(file, path))) files.delete(file)
    },
    // No symlinks in memory: every path is its own canonical location.
    realpath: path => path,
    inspect: path => ({ kind: 'present', realpath: path })
  }

  const entriesUnderRoot = () =>
    [...directories, ...files.keys()].filter(path => path.startsWith(`${recordingsRoot}/`)).sort()

  return { writer, files, operations, entriesUnderRoot }
}

const runId = recordingRunId(new Date('2026-09-30T12:34:56.789Z'), 'a1b2c3d4')

const stagingDir = join(recordingsRoot, runId)

const tempDir = join(recordingsRoot, `.tmp-${runId}`)

const pagingId = dropboxListFolderPagingFixture.caseId

const conflictId = dropboxCreateFolderConflictFixture.caseId

const pagingRecorders = () =>
  new Map([[pagingId, recorderOf(dropboxListFolderPagingFixture.exchanges)]])

const stage = (
  recorders: ReadonlyMap<string, WireRecorderApi>,
  writer: RecordingWriter,
  dir: string = stagingDir
) =>
  Effect.runPromise(
    stageRecordings(dropboxRunner, passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir: dir,
      recordedAt: '2026-09-30'
    }).pipe(Effect.result)
  )

const failureMessage = (result: Awaited<ReturnType<typeof stage>>): string =>
  Result.isFailure(result) ? result.failure.message : expect.fail('expected a refusal')

describe('run-dropbox-conformance --record staging (offline)', () => {
  it('keeps the staging directory gitignored and outside committed sources', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')

    expect(gitignore.split('\n')).toContain('/.conformance-recordings/')
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'dropbox'))
  })

  it('writes the whole batch into a temp directory, then publishes it with one rename', async () => {
    const { writer, files, operations, entriesUnderRoot } = memoryWriter()

    const result = await stage(
      new Map([
        [pagingId, recorderOf(dropboxListFolderPagingFixture.exchanges)],
        [conflictId, recorderOf(dropboxCreateFolderConflictFixture.exchanges)]
      ]),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail('expected staged recordings')
    }

    const staged = [
      join(stagingDir, 'list-folder-paging.ts'),
      join(stagingDir, 'create-folder-conflict.ts'),
      join(stagingDir, 'seeds.ts')
    ]

    expect(operations).toEqual([
      `mkdir ${tempDir}`,
      `write ${join(tempDir, 'list-folder-paging.ts')}`,
      `write ${join(tempDir, 'create-folder-conflict.ts')}`,
      `write ${join(tempDir, 'seeds.ts')}`,
      `rename ${tempDir} -> ${stagingDir}`
    ])
    expect(entriesUnderRoot()).toEqual([stagingDir, ...staged].sort())
    expect(files.get(staged[0] ?? '')).toContain(`"id": "${pagingId}.recorded"`)
    expect(files.get(staged[0] ?? '')).toContain('"evidence": "verified"')
    expect(files.get(staged[0] ?? '')).toContain('"account": "practice"')
    expect(files.get(staged[2] ?? '')).toBe(
      renderSeedsModule(dropboxRunner, dropboxConformanceFixtureSeeds)
    )
    expect(result.success.files).toEqual(staged)
    expect(result.success.checklist.join('\n')).toContain('names: "/Conformance/Paging"')
    expect(result.success.checklist.join('\n')).toContain(
      '  seeds.ts: every account seed names practice-account data; replace each with a synthetic value'
    )
    expect(result.success.checklist.join('\n')).toContain('pagingFolderPath="/Conformance/Paging"')
    expect(result.success.checklist.join('\n')).not.toContain('SHARED SEED')
  })

  it('leaves no run directory and removes the temp directory when a write fails mid-batch', async () => {
    const { writer, operations, entriesUnderRoot } = memoryWriter({ failOnWrite: 1 })

    const result = await stage(
      new Map([
        [pagingId, recorderOf(dropboxListFolderPagingFixture.exchanges)],
        [conflictId, recorderOf(dropboxCreateFolderConflictFixture.exchanges)]
      ]),
      writer
    )

    expect(failureMessage(result)).toBe(
      `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
    )
    expect(operations.at(-1)).toBe(`rm ${tempDir}`)
    expect(entriesUnderRoot()).toEqual([])
  })

  it('leaves no run directory when the publishing rename fails', async () => {
    const { writer, entriesUnderRoot } = memoryWriter({ failRename: true })

    expect(failureMessage(await stage(pagingRecorders(), writer))).toBe(
      `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
    )
    expect(entriesUnderRoot()).toEqual([])
  })

  it('refuses an existing run directory and writes nothing', async () => {
    const { writer, operations } = memoryWriter()

    writer.mkdir(stagingDir)
    operations.length = 0

    expect(failureMessage(await stage(pagingRecorders(), writer))).toBe(
      `Refusing to overwrite ${stagingDir}; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when any recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The lower-cased lookup no longer names the same entry.
    const contradicted = dropboxPathLowerLookupFixture.exchanges.map((exchange, index) =>
      index === 1 &&
      !isWireStreamResponse(exchange.response) &&
      !isWireBase64BodyResponse(exchange.response)
        ? {
            ...exchange,
            response: {
              ...exchange.response,
              body: exchange.response.body.replace('SyntheticMixedCaseFile01', 'SyntheticOther')
            }
          }
        : exchange
    )

    const result = await stage(
      new Map([
        [pagingId, recorderOf(dropboxListFolderPagingFixture.exchanges)],
        [dropboxPathLowerLookupFixture.caseId, recorderOf(contradicted)]
      ]),
      writer
    )

    expect(failureMessage(result)).toBe(
      `${dropboxPathLowerLookupFixture.caseId} did not pass on replay of its recording; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when a recording fails the secret scan', async () => {
    const { writer, operations } = memoryWriter()
    const [first, ...rest] = dropboxListFolderPagingFixture.exchanges

    const leaky: ReadonlyArray<WireExchange> = [
      {
        ...first,
        request: {
          ...first.request,
          headers: { ...first.request.headers, authorization: 'Bearer synthetic-leaked-token-0000' }
        }
      },
      ...rest
    ]

    expect(failureMessage(await stage(new Map([[pagingId, recorderOf(leaky)]]), writer))).toBe(
      `${pagingId}: recording rejected (WireFixtureSecretsFound); nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('refuses a staging directory that is not a direct child of the recordings root', async () => {
    for (const dir of [
      join(repoRoot, 'packages/connectors/src/dropbox/conformance'),
      join(repoRoot, '.conformance-recordings', 'microsoft', runId),
      join(stagingDir, 'nested'),
      recordingsRoot,
      tempDir
    ]) {
      const { writer, operations } = memoryWriter()

      expect(failureMessage(await stage(pagingRecorders(), writer, dir))).toBe(
        `Refusing to stage recordings outside the recordings root (${recordingsRoot}); nothing was written`
      )
      expect(operations).toEqual([])
    }
  })

  it('refuses a recordings root inside committed package sources', async () => {
    const { writer, operations } = memoryWriter()
    const root = join(repoRoot, 'packages/connectors/src/dropbox/conformance/recordings')

    const result = await Effect.runPromise(
      stageRecordings(dropboxRunner, passedReport([pagingId]), pagingRecorders(), recordInputs, {
        writer,
        recordingsRoot: root,
        stagingDir: join(root, runId),
        recordedAt: '2026-09-30'
      }).pipe(Effect.result)
    )

    expect(failureMessage(result)).toBe(
      `Refusing a recordings root inside committed package sources (${root}); nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when no case passed', async () => {
    const { writer, operations } = memoryWriter()

    expect(await stage(new Map(), writer)).toMatchObject({ _tag: 'Success', success: undefined })
    expect(operations).toEqual([])
  })

  it('lists foreign emails, names, and text for review', () => {
    const [first, ...rest] = dropboxListFolderPagingFixture.exchanges

    const leaky: WireFixture = {
      ...dropboxListFolderPagingFixture,
      exchanges: [
        {
          ...first,
          response: {
            status: 200,
            headers: {},
            body: '{"entries":[{".tag":"file","name":"Quarterly numbers.xlsx","path_display":"/Finance/Quarterly numbers.xlsx","sharing_info":{"modified_by":"person@practice.invalid"}}],"cursor":"c","has_more":false}'
          }
        },
        ...rest
      ]
    }

    const spec =
      dropboxCaseSpecs.find(entry => entry.caseId === leaky.caseId) ??
      expect.fail('missing paging spec')

    const checklist = recordingReviewChecklist(dropboxRunner, [{ spec, fixture: leaky }]).join('\n')

    expect(checklist).toContain(
      'emails outside example.test/example.com: "person@practice.invalid"'
    )
    expect(checklist).toContain('"Quarterly numbers.xlsx"')
    expect(checklist).toContain('"/Finance/Quarterly numbers.xlsx"')
  })
})

describe('run-dropbox-conformance --record containment (real filesystem)', () => {
  it('refuses a symlinked recordings directory and writes nothing through it', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-recordings-')))

    try {
      // A tracked-looking target, and a recordings directory that is a symlink into it.
      const target = join(base, 'packages-like-target')

      mkdirSync(target)
      symlinkSync(target, join(base, '.conformance-recordings'))

      const root = join(base, '.conformance-recordings', 'dropbox')

      const result = await Effect.runPromise(
        stageRecordings(dropboxRunner, passedReport([pagingId]), pagingRecorders(), recordInputs, {
          writer: nodeRecordingWriter,
          recordingsRoot: root,
          containmentRoot: base,
          stagingDir: join(root, runId),
          recordedAt: '2026-09-30'
        }).pipe(Effect.result)
      )

      expect(failureMessage(result)).toBe(
        `Refusing recordings under a symlinked or redirected directory (${root}); nothing was written`
      )
      expect(readdirSync(target)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('stages into a real directory under the containment root', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-recordings-')))

    try {
      const root = join(base, '.conformance-recordings', 'dropbox')

      const result = await Effect.runPromise(
        stageRecordings(dropboxRunner, passedReport([pagingId]), pagingRecorders(), recordInputs, {
          writer: nodeRecordingWriter,
          recordingsRoot: root,
          containmentRoot: base,
          stagingDir: join(root, runId),
          recordedAt: '2026-09-30'
        }).pipe(Effect.result)
      )

      expect(Result.isSuccess(result)).toBe(true)
      expect(readdirSync(join(root, runId)).sort()).toEqual(['list-folder-paging.ts', 'seeds.ts'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a dangling symlinked recordings directory and creates nothing through it', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-recordings-')))

    try {
      // The recordings directory is a symlink to a target that does not exist yet.
      const target = join(base, 'packages-like-target')

      symlinkSync(target, join(base, '.conformance-recordings'))

      const root = join(base, '.conformance-recordings', 'dropbox')

      const result = await Effect.runPromise(
        stageRecordings(dropboxRunner, passedReport([pagingId]), pagingRecorders(), recordInputs, {
          writer: nodeRecordingWriter,
          recordingsRoot: root,
          containmentRoot: base,
          stagingDir: join(root, runId),
          recordedAt: '2026-09-30'
        }).pipe(Effect.result)
      )

      expect(failureMessage(result)).toBe(
        `Refusing recordings under a symlinked or redirected directory (${root}); nothing was written`
      )
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('checks physical containment component by component', () => {
    const redirect = (from: string, to: string) => ({
      realpath: (path: string) => path,
      inspect: (path: string) =>
        ({
          kind: 'present',
          realpath: path.startsWith(from) ? to + path.slice(from.length) : path
        }) as const
    })

    const symlinkAt = (link: string) => ({
      realpath: (path: string) => path,
      inspect: (path: string) =>
        path === link
          ? ({ kind: 'refused' } as const)
          : ({ kind: 'present', realpath: path } as const)
    })

    expect(physicallyContained(redirect('/x', '/x'), '/w', ['/w/a/b'])).toBe(true)
    expect(physicallyContained(redirect('/w/a', '/w/elsewhere'), '/w', ['/w/a/b'])).toBe(false)
    expect(physicallyContained(redirect('/x', '/x'), '/w', ['/outside/a'])).toBe(false)
    expect(physicallyContained(symlinkAt('/w/a'), '/w', ['/w/a/b'])).toBe(false)
  })

  it('re-checks containment immediately before publishing, and publishes nothing when it moved', async () => {
    const { writer, operations, entriesUnderRoot } = memoryWriter()
    let renames = 0

    // The temp directory becomes a symlink after its files were written, before the rename.
    const swapping: RecordingWriter = {
      ...writer,
      inspect: path =>
        path === tempDir && operations.some(operation => operation.startsWith('write '))
          ? { kind: 'refused' }
          : writer.inspect(path),
      rename: (from, to) => {
        renames += 1
        writer.rename(from, to)
      }
    }

    expect(failureMessage(await stage(pagingRecorders(), swapping))).toBe(
      `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
    )
    expect(renames).toBe(0)
    expect(entriesUnderRoot().filter(path => path.startsWith(stagingDir))).toEqual([])
  })
})

// Live-run signal handling: an injected signal source, never real process signals.

const fakeSignals = () => {
  const handlers = new Map<CliSignal, Array<() => void>>()

  const source: SignalSource = {
    on: (signal, handler) => {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler])
    },
    off: (signal, handler) => {
      handlers.set(
        signal,
        (handlers.get(signal) ?? []).filter(registered => registered !== handler)
      )
    }
  }

  const emit = (signal: CliSignal) => {
    for (const handler of handlers.get(signal) ?? []) handler()
  }

  const registered = () => [...handlers.values()].reduce((total, list) => total + list.length, 0)

  return { source, emit, registered }
}

const fakeIo = () => {
  const errors: Array<string> = []
  const exitCodes: Array<number> = []
  const forcedExits: Array<number> = []

  const io: CliIo = {
    error: message => {
      errors.push(message)
    },
    setExitCode: code => {
      exitCodes.push(code)
    },
    forceExit: code => {
      forcedExits.push(code)
    }
  }

  return { io, errors, exitCodes, forcedExits }
}

/** A program that starts, then waits; its uninterruptible cleanup waits for `releaseCleanup`. */
const runningProgram = () => {
  const started = Effect.runSync(Deferred.make<void>())
  const releaseCleanup = Effect.runSync(Deferred.make<void>())
  const cleaned: Array<string> = []

  const program = Deferred.succeed(started, undefined).pipe(
    Effect.andThen(Deferred.await(Effect.runSync(Deferred.make<void>()))),
    Effect.ensuring(
      Deferred.await(releaseCleanup).pipe(
        Effect.andThen(Effect.sync(() => cleaned.push('cleaned')))
      )
    )
  )

  return {
    program,
    cleaned,
    started: Effect.runPromise(Deferred.await(started)),
    releaseCleanup: () => Effect.runSync(Deferred.succeed(releaseCleanup, undefined))
  }
}

describe('connector conformance live runs are interruptible', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`interrupts the run on ${signal}, lets the cleanup finish, and exits 130`, async () => {
      const signals = fakeSignals()
      const { io, errors, exitCodes, forcedExits } = fakeIo()
      const running = runningProgram()
      const done = runInterruptibly(running.program, signals.source, io)

      await running.started
      signals.emit(signal)
      running.releaseCleanup()
      await done

      expect(running.cleaned).toEqual(['cleaned'])
      expect(errors[0]).toBe(
        `${signal}: interrupting the run; the running case's cleanup is attempted before exit, and a cleanup that fails prints a WARN line. Send ${signal} again, at least a second later, to exit without waiting.`
      )
      expect(errors.at(-1)).toBe(
        "Interrupted. The running case's cleanup was attempted but is not confirmed: read the WARN lines, and look for yolk-conformance items by hand if in doubt."
      )
      expect(exitCodes).toEqual([130])
      expect(forcedExits).toEqual([])
      expect(signals.registered()).toBe(0)
    })
  }

  it('ignores duplicates of one keypress, and force-exits on a signal a second or more later', async () => {
    const signals = fakeSignals()
    const { io, errors, forcedExits } = fakeIo()
    const running = runningProgram()
    let clock = 10_000
    const done = runInterruptibly(running.program, signals.source, io, { now: () => clock })

    await running.started

    // One Ctrl-C: the node child receives SIGINT, then relayed SIGTERM and SIGINT within ms.
    signals.emit('SIGINT')
    clock += 2
    signals.emit('SIGTERM')
    clock += 30
    signals.emit('SIGINT')
    clock += 967

    // Still inside the window (999 ms after the first): a duplicate, not a second request.
    signals.emit('SIGINT')

    expect(forcedExits).toEqual([])
    expect(errors).toHaveLength(1)

    clock += 1
    signals.emit('SIGINT')

    expect(forcedExits).toEqual([130])
    expect(errors[1]).toBe(
      'Second SIGINT: exiting now without waiting for cleanup. Case-created items may remain: look for yolk-conformance items by hand (a later live run with --allow-writes reversible warns about the ones it finds).'
    )

    // Let the fiber finish so the test leaves nothing running.
    running.releaseCleanup()
    await done
  })

  it('after an interrupt-only exit, prints the fresh leftover lookup before exiting 130', async () => {
    const signals = fakeSignals()
    const { io, errors, exitCodes } = fakeIo()
    const running = runningProgram()

    const done = runInterruptibly(running.program, signals.source, io, {
      afterInterrupt: Effect.succeed([
        'WARN still present after the interruption (from this or an earlier run): /Conformance/Work/yolk-conformance-run-0000beef-copy; check it'
      ])
    })

    await running.started
    signals.emit('SIGINT')
    running.releaseCleanup()
    await done

    expect(errors.slice(-2)).toEqual([
      "Interrupted. The running case's cleanup was attempted but is not confirmed: read the WARN lines, and look for yolk-conformance items by hand if in doubt.",
      'WARN still present after the interruption (from this or an earlier run): /Conformance/Work/yolk-conformance-run-0000beef-copy; check it'
    ])
    expect(exitCodes).toEqual([130])
  })

  it('reports a failed run with exit code 1 and no signal handlers left behind', async () => {
    const signals = fakeSignals()
    const { io, errors, exitCodes } = fakeIo()

    await runInterruptibly(Effect.fail(new Error('synthetic live failure')), signals.source, io)

    expect(errors).toEqual(['synthetic live failure'])
    expect(exitCodes).toEqual([1])
    expect(signals.registered()).toBe(0)
  })
})

describe('connector conformance leftover warnings (read-only)', () => {
  const leftoverListing: WireFixture = {
    id: 'dropbox.leftovers.synthetic',
    caseId: 'dropbox.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.dropboxapi.com/2',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://api.dropboxapi.com/2/files/list_folder',
          headers: { 'content-type': 'application/json' },
          body: { path: '/Conformance/Work', limit: 2000 }
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"entries":[{".tag":"folder","name":"yolk-conformance-run-0000beef-copy","path_lower":"/conformance/work/yolk-conformance-run-0000beef-copy","path_display":"/Conformance/Work/yolk-conformance-run-0000beef-copy","id":"id:SyntheticLeftover01"}],"cursor":"AAHsyntheticLeftoverCursor","has_more":false}'
        }
      }
    ]
  }

  const writesOptions = parse([
    '--live',
    '--owner-approved',
    '--account',
    'practice',
    '--allow-writes',
    'reversible'
  ])

  it('warns once per leftover before any write case and never deletes', async () => {
    const lines = await Effect.runPromise(
      leftoverWarnings(
        dropboxRunner,
        writesOptions,
        recordInputs,
        ReplayHttpClient.layer([leftoverListing])
      )
    )

    expect(lines).toEqual([
      'WARN leftover from an earlier run: /Conformance/Work/yolk-conformance-run-0000beef-copy; delete it by hand after checking that no run is still using it (nothing is deleted automatically)'
    ])
  })

  it('after an interruption, lists what is still present, this run included', async () => {
    const lines = await Effect.runPromise(
      leftoverWarnings(
        dropboxRunner,
        writesOptions,
        recordInputs,
        ReplayHttpClient.layer([leftoverListing]),
        'after-interrupt'
      )
    )

    expect(lines).toEqual([
      'WARN still present after the interruption (from this or an earlier run): /Conformance/Work/yolk-conformance-run-0000beef-copy; delete it by hand after checking that no run is still using it (nothing is deleted automatically)'
    ])
  })

  it('names the failure code when the lookup is refused', async () => {
    const refused: WireFixture = {
      ...leftoverListing,
      exchanges: [
        {
          request: leftoverListing.exchanges[0].request,
          response: {
            status: 401,
            headers: { 'content-type': 'application/json' },
            body: '{"error_summary":"invalid_access_token/.","error":{".tag":"invalid_access_token"}}'
          }
        }
      ]
    }

    const lines = await Effect.runPromise(
      leftoverWarnings(
        dropboxRunner,
        writesOptions,
        recordInputs,
        ReplayHttpClient.layer([refused])
      )
    )

    expect(lines).toEqual([
      'WARN could not look for leftovers (lookup failed: dropbox_unauthorized HTTP 401); check for yolk-conformance items by hand'
    ])
  })

  it('does not look when no write case would run', async () => {
    // An empty replay would fail closed on any request: none is sent.
    const lines = await Effect.runPromise(
      leftoverWarnings(dropboxRunner, live(), recordInputs, ReplayHttpClient.layer([]))
    )

    expect(lines).toEqual([])
  })

  it('warns, without stopping the run, when the lookup fails', async () => {
    const lines = await Effect.runPromise(
      leftoverWarnings(dropboxRunner, writesOptions, recordInputs, ReplayHttpClient.layer([]))
    )

    expect(lines).toEqual([
      'WARN could not look for leftovers (lookup failed: transport_failed); check for yolk-conformance items by hand'
    ])
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

describe('run-dropbox-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { DROPBOX_ACCESS_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain(
      'SKIP  dropbox.files.upload-rev-precondition  [write-reversible]  writes-not-allowed'
    )
  })

  it('refuses --live in CI before reading any token', async () => {
    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      DROPBOX_ACCESS_TOKEN: 'synthetic-token',
      CI: 'true'
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })
})
