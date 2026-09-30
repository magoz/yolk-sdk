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
  ownerApprovalRequiredMessage,
  parseRunArgs,
  planRun,
  recordingReviewChecklist,
  recordingRunId,
  renderFixtureModule,
  renderSeedsModule,
  stageRecordings,
  staleSharedSeeds,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  dropboxCaseSpecs,
  dropboxRunner,
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
      "Use a practice Dropbox account only, with the repository owner's approval; never in CI. Write cases work inside their own yolk-conformance folder under --work-folder and delete it again."
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
    expect(liveInputs(dropboxRunner, live(readSeedFlags), env)).toMatchObject({
      inputs: {
        account: 'practice',
        accessToken: 'synthetic-token',
        seeds: { workFolderPath: '/Conformance/Work', searchQuery: 'yolk-search-probe' }
      }
    })
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
      { workFolderPath: '/Practice/Work' },
      ['dropbox.files.create-folder-conflict']
    )

    expect(merged).toEqual({ ...dropboxConformanceFixtureSeeds, workFolderPath: '/Practice/Work' })
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
    }
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
