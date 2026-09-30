import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
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
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  microsoftCalendarListRangeFixture,
  microsoftConformanceCases,
  microsoftConformanceFixtureSeeds,
  microsoftOneDriveCreateFolderFixture,
  microsoftOutlookPagingNextLinkFixture
} from '../../packages/connectors/src/microsoft/conformance/index.ts'
import {
  liveInCiMessage,
  nodeRecordingWriter,
  ownerApprovalRequiredMessage,
  type CliIo,
  type CliSignal,
  type RecordingWriter,
  type SignalSource
} from '../connector-conformance-internal.ts'
import {
  accessTokenRequiredMessage,
  defaultRunOptions,
  dryRunReport,
  liveAccountRequiredMessage,
  liveCredential,
  liveInputs,
  liveTarget,
  mergedFixtureSeeds,
  microsoftCaseSpecs,
  microsoftRecoveryAdvice,
  parseRunArgs,
  planMicrosoftRun,
  recordingReviewChecklist,
  recordingRunId,
  recordingsRoot,
  renderFixtureModule,
  renderSeedsModule,
  runMicrosoftInterruptibly,
  stageRecordings,
  staleSharedSeeds,
  type LiveInputs
} from '../run-microsoft-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-microsoft-conformance.ts')

const readSeedFlags = [
  '--range-start=2026-09-21T00:00:00Z',
  '--range-end=2026-09-28T00:00:00Z',
  '--event=AAMkAGI2-synthetic-event-0001=',
  '--event-start=2026-09-23T12:00:00Z',
  '--attachment-message=AAMkAGI2-synthetic-message-0001=',
  '--paging-folder=AAMkAGI2-synthetic-folder-0001='
]

describe('run-microsoft-conformance arguments', () => {
  it('defaults to a dry run with no writes, no approval, no account, and no seeds', () => {
    expect(parseRunArgs([])).toEqual(defaultRunOptions)
    expect(defaultRunOptions.ownerApproved).toBe(false)
    expect(liveTarget(defaultRunOptions)).toEqual({
      kind: 'live',
      account: 'dry-run',
      allowWrites: 'none',
      allowIrreversible: []
    })
  })

  it('requires --owner-approved and an explicit synthetic --account label with --live', () => {
    expect(() => parseRunArgs(['--live'])).toThrow(ownerApprovalRequiredMessage)
    expect(() => parseRunArgs(['--live', '--account', 'practice'])).toThrow(
      ownerApprovalRequiredMessage
    )
    expect(() => parseRunArgs(['--live', '--owner-approved'])).toThrow(liveAccountRequiredMessage)
    expect(() =>
      parseRunArgs(['--live', '--owner-approved', '--account', 'Example Person'])
    ).toThrow('--account must be a short synthetic label')
    expect(parseRunArgs(['--live', '--owner-approved', '--account', 'practice'])).toMatchObject({
      live: true,
      ownerApproved: true,
      account: 'practice'
    })
    expect(parseRunArgs(['--live', '--help']).help).toBe(true)
  })

  it('refuses --live whenever CI is non-empty, 0 and false included', () => {
    const argv = ['--live', '--owner-approved', '--account', 'practice']

    for (const ci of ['true', '1', '0', 'false']) {
      expect(() => parseRunArgs(argv, { CI: ci }), ci).toThrow(liveInCiMessage)
    }

    expect(parseRunArgs(argv, { CI: '' }).live).toBe(true)
    // A dry run is allowed in CI: it makes no request and reads no credential.
    expect(parseRunArgs([], { CI: 'true' })).toEqual(defaultRunOptions)
  })

  it('reads write policy, record, and seeds from flags over env', () => {
    const options = parseRunArgs(
      [
        '--live',
        '--owner-approved',
        '--account=practice',
        '--allow-writes',
        'reversible',
        '--record',
        '--mailbox',
        'ada@example.test'
      ],
      {
        MICROSOFT_CONFORMANCE_MAILBOX: 'grace@example.test',
        MICROSOFT_CONFORMANCE_DRIVE: ' b!synthetic-drive-0001 ',
        MICROSOFT_CONFORMANCE_EVENT: ''
      }
    )

    expect(options).toEqual({
      live: true,
      help: false,
      record: true,
      ownerApproved: true,
      account: 'practice',
      allowWrites: 'reversible',
      seeds: { mailbox: 'ada@example.test', driveId: 'b!synthetic-drive-0001' }
    })
  })

  it('rejects unknown flags, bad values, irreversible flags, and --record without --live', () => {
    expect(() => parseRunArgs(['--nope'])).toThrow('Unknown argument')
    expect(() => parseRunArgs(['--mailbox'])).toThrow('requires a value')
    expect(() => parseRunArgs(['--allow-writes=all'])).toThrow('none or reversible')
    // There are no write-irreversible Microsoft cases, so there is no flag to allow one.
    expect(() =>
      parseRunArgs(['--allow-irreversible', 'microsoft.calendar.cancel-semantics'])
    ).toThrow('Unknown argument')
    expect(() => parseRunArgs(['--record'])).toThrow('--record requires --live')
  })
})

describe('run-microsoft-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(microsoftCaseSpecs.map(spec => spec.caseId)).toEqual(
      microsoftConformanceCases.map(testCase => testCase.id)
    )
    expect(
      microsoftConformanceCases.some(testCase => testCase.safety === 'write-irreversible')
    ).toBe(false)
  })

  it('runs only read cases by default and every case with reversible writes', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planMicrosoftRun(parseRunArgs(argv)).map(entry => [entry.id, entry.skipReason ?? 'runs'])

    expect(skips([])).toEqual([
      ['microsoft.calendar.list-range-returns-events', 'runs'],
      ['microsoft.calendar.timestamp-precision', 'runs'],
      ['microsoft.calendar.create-returns-event-id', 'writes-not-allowed'],
      ['microsoft.calendar.cancel-semantics', 'writes-not-allowed'],
      ['microsoft.outlook.attachments-listing', 'runs'],
      ['microsoft.outlook.attachment-content-id', 'runs'],
      ['microsoft.outlook.paging-next-link', 'runs'],
      ['microsoft.outlook.immutable-id-survives-move', 'writes-not-allowed'],
      ['microsoft.outlook.concurrent-writes-same-message', 'writes-not-allowed'],
      ['microsoft.onedrive.create-folder-roundtrip', 'writes-not-allowed'],
      ['microsoft.onedrive.copy-accepted-monitor', 'writes-not-allowed']
    ])
    expect(skips(['--allow-writes', 'reversible']).every(([, skip]) => skip === 'runs')).toBe(true)
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    const report = dryRunReport(parseRunArgs(['--allow-writes', 'reversible']))

    expect(report.split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs MICROSOFT_ACCESS_TOKEN).',
      'Plan for a live target: allowWrites=reversible',
      'RUN   microsoft.calendar.list-range-returns-events  [read]  needs --range-start, --range-end, --event',
      'RUN   microsoft.calendar.timestamp-precision  [read]  needs --range-start, --range-end, --event, --event-start',
      'RUN   microsoft.calendar.create-returns-event-id  [write-reversible]',
      'RUN   microsoft.calendar.cancel-semantics  [write-reversible]',
      'RUN   microsoft.outlook.attachments-listing  [read]  needs --attachment-message',
      'RUN   microsoft.outlook.attachment-content-id  [read]  needs --attachment-message',
      'RUN   microsoft.outlook.paging-next-link  [read]  needs --paging-folder',
      'RUN   microsoft.outlook.immutable-id-survives-move  [write-reversible]',
      'RUN   microsoft.outlook.concurrent-writes-same-message  [write-reversible]',
      'RUN   microsoft.onedrive.create-folder-roundtrip  [write-reversible]  needs --drive-parent',
      'RUN   microsoft.onedrive.copy-accepted-monitor  [write-reversible]  needs --drive, --drive-parent, --copy-source',
      "Use a Microsoft 365 practice tenant only, with the repository owner's approval; never in CI. Write cases create their own event, draft, or folder and remove it again; nothing sends mail or invitations."
    ])
  })
})

describe('run-microsoft-conformance live refusal (no network)', () => {
  const live = (argv: ReadonlyArray<string>) =>
    parseRunArgs(['--live', '--owner-approved', '--account', 'practice', ...argv])

  it('refuses in CI, without approval, an account, or an access token', () => {
    const env = { MICROSOFT_ACCESS_TOKEN: 'synthetic-token' }

    expect(liveInputs(live(readSeedFlags), { ...env, CI: 'false' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(liveInputs({ ...defaultRunOptions, live: true, account: 'practice' }, env)).toEqual({
      refusal: ownerApprovalRequiredMessage
    })
    expect(liveInputs({ ...defaultRunOptions, live: true, ownerApproved: true }, env)).toEqual({
      refusal: liveAccountRequiredMessage
    })
    expect(liveInputs(live(readSeedFlags), {})).toEqual({ refusal: accessTokenRequiredMessage })
    expect(liveInputs(live(readSeedFlags), { MICROSOFT_ACCESS_TOKEN: '  ' })).toEqual({
      refusal: accessTokenRequiredMessage
    })
  })

  it('refuses when a case that would run lacks its seed or a seed is invalid', () => {
    const env = { MICROSOFT_ACCESS_TOKEN: 'synthetic-token' }

    expect(liveInputs(live([]), env)).toEqual({
      refusal:
        'Missing seed identities for the cases that would run: --range-start, --range-end, --event, --event-start, --attachment-message, --paging-folder'
    })
    expect(liveInputs(live([...readSeedFlags, '--event-start=2026-09-23 12:00']), env)).toEqual({
      refusal:
        'Seed identities must be non-empty trimmed values, and --range-start, --range-end, and --event-start ISO UTC instants (for example 2026-09-21T00:00:00Z)'
    })

    expect(liveInputs(live([...readSeedFlags, '--mailbox=ada@example.test']), env)).toMatchObject({
      inputs: {
        account: 'practice',
        accessToken: 'synthetic-token',
        seeds: { mailbox: 'ada@example.test', calendarEventStart: '2026-09-23T12:00:00Z' }
      }
    })
  })

  it('binds the live credential to the mailbox seed as its account', () => {
    expect(liveCredential('synthetic-token', { mailbox: 'ada@example.test' })).toMatchObject({
      _tag: 'OAuthCredential',
      provider: 'microsoft',
      accountId: 'ada@example.test'
    })
    expect(liveCredential('synthetic-token', {}).accountId).toBeUndefined()
  })
})

describe('run-microsoft-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/microsoft/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(microsoftConformanceFixtureSeeds)).toBe(committed)
  })

  it('merges the required and optional seeds of recorded cases only', () => {
    const merged = mergedFixtureSeeds(
      microsoftConformanceFixtureSeeds,
      { pagingFolderId: 'AAMkAGI2-synthetic-folder-0009=' },
      ['microsoft.outlook.paging-next-link']
    )

    // The live run used /me: the mailbox seed is dropped with the recorded case.
    const { mailbox: _dropped, ...rest } = microsoftConformanceFixtureSeeds

    expect(merged).toEqual({ ...rest, pagingFolderId: 'AAMkAGI2-synthetic-folder-0009=' })
    expect(
      staleSharedSeeds(microsoftConformanceFixtureSeeds, merged, [
        'microsoft.outlook.paging-next-link'
      ]).map(entry => entry.key)
    ).toEqual(['mailbox'])
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec = microsoftCaseSpecs.find(
      entry => entry.caseId === 'microsoft.outlook.paging-next-link'
    )

    if (spec === undefined) {
      return expect.fail('missing paging spec')
    }

    const source = renderFixtureModule(spec, microsoftOutlookPagingNextLinkFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const microsoftOutlookPagingNextLinkFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:microsoft --live --owner-approved --account <label> --record'
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
    safety: microsoftConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs = {
  account: 'practice',
  accessToken: 'synthetic-token',
  seeds: microsoftConformanceFixtureSeeds
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/**
 * In-memory directory tree behind `RecordingWriter`. `failOnWrite` throws on that (0-based)
 * `writeFile` call; `failRename` throws on the rename.
 */
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

  /** Directories and files strictly inside `recordingsRoot`. */
  const entriesUnderRoot = () =>
    [...directories, ...files.keys()].filter(path => path.startsWith(`${recordingsRoot}/`)).sort()

  return { writer, files, operations, entriesUnderRoot }
}

const runId = recordingRunId(new Date('2026-09-30T12:34:56.789Z'), 'a1b2c3d4')

const stagingDir = join(recordingsRoot, runId)

const tempDir = join(recordingsRoot, `.tmp-${runId}`)

const rangeId = microsoftCalendarListRangeFixture.caseId

const folderId = microsoftOneDriveCreateFolderFixture.caseId

const rangeRecorders = () =>
  new Map([[rangeId, recorderOf(microsoftCalendarListRangeFixture.exchanges)]])

/** An opaque live token: no Bearer prefix, not JWT-shaped, no known API-key prefix. */
const opaqueToken = 'opaque7c1d9e2b4a6f8e0d3c5b'

const tokenRefusal =
  'The staged files or the review checklist would contain the live access token; nothing was written'

const stageWithToken = (recorders: ReadonlyMap<string, WireRecorderApi>, writer: RecordingWriter) =>
  Effect.runPromise(
    stageRecordings(
      passedReport([...recorders.keys()]),
      recorders,
      { ...recordInputs, accessToken: opaqueToken },
      { writer, stagingDir, recordedAt: '2026-09-30' }
    ).pipe(Effect.result)
  )

const stage = (
  recorders: ReadonlyMap<string, WireRecorderApi>,
  writer: RecordingWriter,
  dir: string = stagingDir
) =>
  Effect.runPromise(
    stageRecordings(passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir: dir,
      recordedAt: '2026-09-30'
    }).pipe(Effect.result)
  )

const failureMessage = (result: Awaited<ReturnType<typeof stage>>): string =>
  Result.isFailure(result) ? result.failure.message : expect.fail('expected a refusal')

describe('run-microsoft-conformance --record staging (offline)', () => {
  it('keeps the staging directory gitignored and outside committed sources', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')

    expect(gitignore.split('\n')).toContain('/.conformance-recordings/')
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'microsoft'))
  })

  it('names each run directory by UTC date, time, and a random suffix', () => {
    expect(runId).toBe('2026-09-30T123456Z-a1b2c3d4')
  })

  it('writes the whole batch into a temp directory, then publishes it with one rename', async () => {
    const { writer, files, operations, entriesUnderRoot } = memoryWriter()

    const result = await stage(
      new Map([
        [rangeId, recorderOf(microsoftCalendarListRangeFixture.exchanges)],
        [folderId, recorderOf(microsoftOneDriveCreateFolderFixture.exchanges)]
      ]),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail('expected staged recordings')
    }

    const staged = [
      join(stagingDir, 'calendar-list-range.ts'),
      join(stagingDir, 'onedrive-create-folder.ts'),
      join(stagingDir, 'seeds.ts')
    ]

    expect(operations).toEqual([
      `mkdir ${tempDir}`,
      `write ${join(tempDir, 'calendar-list-range.ts')}`,
      `write ${join(tempDir, 'onedrive-create-folder.ts')}`,
      `write ${join(tempDir, 'seeds.ts')}`,
      `rename ${tempDir} -> ${stagingDir}`
    ])
    expect(entriesUnderRoot()).toEqual([stagingDir, ...staged].sort())
    expect(files.get(staged[0] ?? '')).toContain(`"id": "${rangeId}.recorded"`)
    expect(files.get(staged[0] ?? '')).toContain('"evidence": "verified"')
    expect(files.get(staged[0] ?? '')).toContain('"account": "practice"')
    expect(files.get(staged[2] ?? '')).toBe(renderSeedsModule(microsoftConformanceFixtureSeeds))
    expect(result.success.files).toEqual(staged)
    expect(result.success.checklist.join('\n')).toContain(
      'names and subjects: "Synthetic planning session"'
    )
    expect(result.success.checklist.join('\n')).not.toContain('SHARED SEED')
  })

  it('leaves no run directory and removes the temp directory when a write fails mid-batch', async () => {
    const { writer, operations, entriesUnderRoot } = memoryWriter({ failOnWrite: 1 })

    const result = await stage(
      new Map([
        [rangeId, recorderOf(microsoftCalendarListRangeFixture.exchanges)],
        [folderId, recorderOf(microsoftOneDriveCreateFolderFixture.exchanges)]
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

    expect(failureMessage(await stage(rangeRecorders(), writer))).toBe(
      `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
    )
    expect(entriesUnderRoot()).toEqual([])
  })

  it('refuses an existing run directory and writes nothing', async () => {
    const { writer, operations } = memoryWriter()

    writer.mkdir(stagingDir)
    operations.length = 0

    expect(failureMessage(await stage(rangeRecorders(), writer))).toBe(
      `Refusing to overwrite ${stagingDir}; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when any recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The range recording no longer supports its claim: the populated range came back empty.
    const contradicted = microsoftCalendarListRangeFixture.exchanges.map(exchange =>
      !isWireStreamResponse(exchange.response) && !isWireBase64BodyResponse(exchange.response)
        ? {
            ...exchange,
            response: {
              status: exchange.response.status,
              headers: exchange.response.headers,
              body: JSON.stringify({ ...JSON.parse(exchange.response.body), value: [] })
            }
          }
        : exchange
    )

    const result = await stage(
      new Map([
        [folderId, recorderOf(microsoftOneDriveCreateFolderFixture.exchanges)],
        [rangeId, recorderOf(contradicted)]
      ]),
      writer
    )

    expect(failureMessage(result)).toBe(
      `${rangeId} did not pass on replay of its recording; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when a recording fails the secret scan', async () => {
    const { writer, operations } = memoryWriter()
    const [first, ...rest] = microsoftCalendarListRangeFixture.exchanges

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

    expect(failureMessage(await stage(new Map([[rangeId, recorderOf(leaky)]]), writer))).toBe(
      `${rangeId}: recording rejected (WireFixtureSecretsFound); nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when a JSON body field echoes the live access token', async () => {
    const { writer, operations } = memoryWriter()
    const [first, ...rest] = microsoftCalendarListRangeFixture.exchanges

    if (isWireStreamResponse(first.response) || isWireBase64BodyResponse(first.response)) {
      return expect.fail('expected a text calendar response')
    }

    // An opaque (not JWT-shaped, as consumer tokens are) token in an event subject: the secret scan
    // cannot see it.
    expect(first.response.body).toContain('"subject":"')

    const echoed: ReadonlyArray<WireExchange> = [
      {
        ...first,
        response: {
          ...first.response,
          body: first.response.body.replace('"subject":"', `"subject":"${opaqueToken} `)
        }
      },
      ...rest
    ]

    const result = await stageWithToken(new Map([[rangeId, recorderOf(echoed)]]), writer)

    expect(failureMessage(result)).toBe(tokenRefusal)
    expect(operations).toEqual([])
  })

  it('stages the same recording when no field carries the token', async () => {
    const { writer } = memoryWriter()

    expect(Result.isSuccess(await stageWithToken(rangeRecorders(), writer))).toBe(true)
  })

  it('refuses a staging directory that is not a direct child of the recordings root', async () => {
    for (const dir of [
      join(repoRoot, 'packages/connectors/src/microsoft/conformance'),
      join(repoRoot, '.conformance-recordings', 'fortnox', runId),
      join(stagingDir, 'nested'),
      recordingsRoot,
      tempDir
    ]) {
      const { writer, operations } = memoryWriter()

      expect(failureMessage(await stage(rangeRecorders(), writer, dir))).toBe(
        `Refusing to stage recordings outside the recordings root (${recordingsRoot}); nothing was written`
      )
      expect(operations).toEqual([])
    }
  })

  it('refuses a recordings root inside committed package sources', async () => {
    const { writer, operations } = memoryWriter()
    const root = join(repoRoot, 'packages/connectors/src/microsoft/conformance/recordings')

    const result = await Effect.runPromise(
      stageRecordings(passedReport([rangeId]), rangeRecorders(), recordInputs, {
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

  it('lists foreign emails, tenant hosts, names, and body text for review', () => {
    const [first, ...rest] = microsoftOutlookPagingNextLinkFixture.exchanges

    const leaky: WireFixture = {
      ...microsoftOutlookPagingNextLinkFixture,
      exchanges: [
        {
          ...first,
          response: {
            status: 200,
            headers: {},
            body: '{"value":[{"id":"x","subject":"Quarterly numbers","bodyPreview":"Hi team","from":{"emailAddress":{"name":"Person","address":"person@practice.invalid"}},"toRecipients":[{"emailAddress":{"address":"ada@example.test"}}],"webLink":"https://practice-tenant-my.sharepoint.com/x"}]}'
          }
        },
        ...rest
      ]
    }

    const spec =
      microsoftCaseSpecs.find(entry => entry.caseId === leaky.caseId) ??
      expect.fail('missing paging spec')

    const checklist = recordingReviewChecklist([{ spec, fixture: leaky }]).join('\n')

    expect(checklist).toContain(
      'emails outside example.test/example.com: "person@practice.invalid"'
    )
    expect(checklist).not.toContain('"ada@example.test"')
    expect(checklist).toContain('tenant host names: "practice-tenant-my.sharepoint.com"')
    expect(checklist).toContain('"Quarterly numbers"')
    expect(checklist).toContain('body text: "Hi team"')
  })
})

describe('run-microsoft-conformance --record containment (real filesystem)', () => {
  const stageUnder = (base: string) => {
    const root = join(base, '.conformance-recordings', 'microsoft')

    return {
      root,
      result: Effect.runPromise(
        stageRecordings(passedReport([rangeId]), rangeRecorders(), recordInputs, {
          writer: nodeRecordingWriter,
          recordingsRoot: root,
          containmentRoot: base,
          stagingDir: join(root, runId),
          recordedAt: '2026-09-30'
        }).pipe(Effect.result)
      )
    }
  }

  it('refuses a symlinked recordings directory and writes nothing through it', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-recordings-')))

    try {
      const target = join(base, 'packages-like-target')

      mkdirSync(target)
      symlinkSync(target, join(base, '.conformance-recordings'))

      const { root, result } = stageUnder(base)

      expect(failureMessage(await result)).toBe(
        `Refusing recordings under a symlinked or redirected directory (${root}); nothing was written`
      )
      expect(readdirSync(target)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a dangling symlinked recordings directory and creates nothing through it', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-recordings-')))

    try {
      const target = join(base, 'packages-like-target')

      symlinkSync(target, join(base, '.conformance-recordings'))

      const { root, result } = stageUnder(base)

      expect(failureMessage(await result)).toBe(
        `Refusing recordings under a symlinked or redirected directory (${root}); nothing was written`
      )
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('stages into a real directory under the containment root', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-recordings-')))

    try {
      const { root, result } = stageUnder(base)

      expect(Result.isSuccess(await result)).toBe(true)
      expect(readdirSync(join(root, runId)).sort()).toEqual(['calendar-list-range.ts', 'seeds.ts'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
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

    expect(failureMessage(await stage(rangeRecorders(), swapping))).toBe(
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
        Effect.andThen(Effect.sync(() => cleaned.push('removed')))
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

describe('run-microsoft-conformance live runs are interruptible', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`interrupts the run on ${signal}, lets the removal finish, and exits 130 with Microsoft advice`, async () => {
      const signals = fakeSignals()
      const { io, errors, exitCodes, forcedExits } = fakeIo()
      const running = runningProgram()
      const done = runMicrosoftInterruptibly(running.program, signals.source, io, { pid: 4242 })

      await running.started
      signals.emit(signal)
      running.releaseCleanup()
      await done

      expect(running.cleaned).toEqual(['removed'])
      expect(errors[0]).toContain(
        `${signal}: interrupting the run (pid 4242); the running case's cleanup is attempted before exit`
      )
      expect(errors.at(-1)).toBe(`Interrupted. Read the WARN lines. ${microsoftRecoveryAdvice}`)
      // This runner has no leftover lookup, so no message may promise one.
      expect(errors.join('\n')).not.toContain('warns about the ones it finds')
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

    const done = runMicrosoftInterruptibly(running.program, signals.source, io, {
      now: () => clock
    })

    await running.started

    // One Ctrl-C: the node child receives SIGINT, then relayed SIGTERM and SIGINT within ms.
    signals.emit('SIGINT')
    clock += 2
    signals.emit('SIGTERM')
    clock += 997
    signals.emit('SIGINT')

    expect(forcedExits).toEqual([])
    expect(errors).toHaveLength(1)

    clock += 1
    signals.emit('SIGINT')

    expect(forcedExits).toEqual([130])
    expect(errors[1]).toBe(
      `Second SIGINT: exiting now without waiting for cleanup. ${microsoftRecoveryAdvice}`
    )

    running.releaseCleanup()
    await done
  })

  it('reports a failed run with exit code 1 and no signal handlers left behind', async () => {
    const signals = fakeSignals()
    const { io, errors, exitCodes } = fakeIo()

    await runMicrosoftInterruptibly(
      Effect.fail(new Error('synthetic live failure')),
      signals.source,
      io
    )

    expect(errors).toEqual(['synthetic live failure'])
    expect(exitCodes).toEqual([1])
    expect(signals.registered()).toBe(0)
  })
})

const runCli = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
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

describe('run-microsoft-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { MICROSOFT_ACCESS_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain(
      'SKIP  microsoft.onedrive.copy-accepted-monitor  [write-reversible]  writes-not-allowed'
    )
  })

  it('refuses --live in CI before reading any token', async () => {
    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      MICROSOFT_ACCESS_TOKEN: 'synthetic-token',
      CI: 'true'
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })

  it('refuses --live without --owner-approved before reading any token', async () => {
    const result = await runCli(['--live', '--account', 'practice'], {
      MICROSOFT_ACCESS_TOKEN: 'synthetic-token',
      CI: ''
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(ownerApprovalRequiredMessage)
  })
})
