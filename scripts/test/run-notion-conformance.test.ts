import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireExchange
} from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  notionConformanceCases,
  notionConformanceFixtureSeeds,
  notionSearchPagingFixture,
  notionTitlePlainTextFixture,
  notionPinnedVersionFixture
} from '../../packages/connectors/src/notion/conformance/index.ts'
import {
  accessTokenRequiredMessage,
  dryRunReport,
  liveInCiMessage,
  liveInputs,
  ownerApprovalRequiredMessage,
  parseRunArgs,
  planRun,
  recordingRunId,
  renderFixtureModule,
  renderSeedsModule,
  stageRecordings,
  type LiveInputs,
  type RecordingWriter
} from '../connector-conformance-internal.ts'
import {
  liveCredential,
  notionCaseSpecs,
  notionRunner,
  recordingsRoot
} from '../run-notion-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-notion-conformance.ts')

const parse = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  parseRunArgs(notionRunner, argv, env)

const live = (argv: ReadonlyArray<string> = []) =>
  parse(['--live', '--owner-approved', '--account', 'practice', ...argv])

const readSeedFlags = [
  '--search-query=yolk-search-probe',
  '--title-page=1f000000-0000-4000-8000-000000000001',
  '--title-page-title=Synthetic Title Page',
  '--blocks-page=1f000000-0000-4000-8000-000000000002',
  '--property-page=1f000000-0000-4000-8000-000000000003',
  '--property-id=Syn%3Ap',
  '--database=1f000000-0000-4000-8000-000000000004'
]

describe('run-notion-conformance arguments', () => {
  it('requires CI to be empty, --owner-approved, and --account with --live', () => {
    expect(() =>
      parse(['--live', '--owner-approved', '--account', 'practice'], { CI: '0' })
    ).toThrow(liveInCiMessage)
    expect(() => parse(['--live', '--account', 'practice'])).toThrow(ownerApprovalRequiredMessage)
    expect(live()).toMatchObject({ live: true, ownerApproved: true, account: 'practice' })
  })

  it('reads seeds from flags over env', () => {
    expect(
      parse(['--parent-page', '1f000000-0000-4000-8000-000000000005'], {
        NOTION_CONFORMANCE_PARENT_PAGE: '1f000000-0000-4000-8000-000000000009',
        NOTION_CONFORMANCE_DATABASE: ' 1f000000-0000-4000-8000-000000000004 '
      }).seeds
    ).toEqual({
      parentPageId: '1f000000-0000-4000-8000-000000000005',
      databaseId: '1f000000-0000-4000-8000-000000000004'
    })
  })

  it('rejects an irreversible flag: the Notion runner has no irreversible case', () => {
    expect(() => parse(['--allow-irreversible', 'notion.pages.archive-in-trash'])).toThrow(
      'Unknown argument'
    )
    expect(notionConformanceCases.some(testCase => testCase.safety === 'write-irreversible')).toBe(
      false
    )
  })
})

describe('run-notion-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(notionCaseSpecs.map(spec => spec.caseId)).toEqual(
      notionConformanceCases.map(testCase => testCase.id)
    )

    for (const spec of notionCaseSpecs) {
      expect(
        readFileSync(
          join(repoRoot, 'packages/connectors/src/notion/conformance', spec.fileName),
          'utf8'
        )
      ).toContain(`export const ${spec.exportName}: WireFixture`)
    }
  })

  it('runs only read cases by default and every case with reversible writes', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planRun(notionRunner, parse(argv)).map(entry => [entry.id, entry.skipReason ?? 'runs'])

    expect(skips([]).filter(([, skip]) => skip !== 'runs')).toEqual([
      ['notion.pages.archive-in-trash', 'writes-not-allowed']
    ])
    expect(skips(['--allow-writes', 'reversible']).every(([, skip]) => skip === 'runs')).toBe(true)
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    expect(dryRunReport(notionRunner, parse([])).split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs NOTION_API_TOKEN).',
      'Plan for a live target: allowWrites=none',
      'RUN   notion.search.cursor-paging  [read]  needs --search-query',
      'RUN   notion.api.pinned-version-accepted  [read]',
      'RUN   notion.errors.error-envelope  [read]',
      'RUN   notion.pages.title-plain-text  [read]  needs --title-page, --title-page-title',
      'RUN   notion.blocks.children-cursor-paging  [read]  needs --blocks-page',
      'RUN   notion.pages.property-item-paging  [read]  needs --property-page, --property-id',
      'RUN   notion.data-sources.database-split  [read]  needs --database',
      'SKIP  notion.pages.archive-in-trash  [write-reversible]  writes-not-allowed',
      "Use a practice Notion workspace only, with the repository owner's approval; never in CI. Write cases create their own page under --parent-page and move it to the trash again."
    ])
  })
})

describe('run-notion-conformance live refusal (no network)', () => {
  const env = { NOTION_API_TOKEN: 'synthetic-token' }

  it('refuses without a token or the seeds of a case that would run', () => {
    expect(liveInputs(notionRunner, live(readSeedFlags), {})).toEqual({
      refusal: accessTokenRequiredMessage(notionRunner)
    })
    expect(
      liveInputs(notionRunner, live(['--allow-writes=reversible', ...readSeedFlags]), env)
    ).toEqual({ refusal: 'Missing seed identities for the cases that would run: --parent-page' })
    expect(liveInputs(notionRunner, live(readSeedFlags), { ...env, CI: 'false' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(liveInputs(notionRunner, live(readSeedFlags), env)).toMatchObject({
      inputs: { account: 'practice', seeds: { propertyId: 'Syn%3Ap' } }
    })
  })

  it('binds the live token as an API key credential for the notion.api_token slot', () => {
    expect(liveCredential('synthetic-token')).toMatchObject({
      _tag: 'ApiKeyCredential',
      key: 'synthetic-token'
    })
  })

  it('keeps notion-version in recordings', () => {
    expect(notionRunner.recordedRequestHeaders).toEqual(['notion-version'])
  })
})

describe('run-notion-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/notion/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(notionRunner, notionConformanceFixtureSeeds)).toBe(committed)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec =
      notionCaseSpecs.find(entry => entry.caseId === notionSearchPagingFixture.caseId) ??
      expect.fail('missing search spec')

    const source = renderFixtureModule(notionRunner, spec, notionSearchPagingFixture)

    expect(source).toContain('export const notionSearchPagingFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:notion --live --owner-approved --account <label> --record'
    )
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
    safety: 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs<typeof notionConformanceFixtureSeeds> = {
  account: 'practice',
  accessToken: 'synthetic-token',
  seeds: notionConformanceFixtureSeeds
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

const runId = recordingRunId(new Date('2026-09-30T12:34:56.789Z'), 'a1b2c3d4')

const stagingDir = join(recordingsRoot, runId)

const stage = (recorders: ReadonlyMap<string, WireRecorderApi>, writer: RecordingWriter) =>
  Effect.runPromise(
    stageRecordings(notionRunner, passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir,
      recordedAt: '2026-09-30'
    }).pipe(Effect.result)
  )

describe('run-notion-conformance --record staging (offline)', () => {
  it('stages under the gitignored notion recordings root', async () => {
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'notion'))

    const { writer, files } = memoryWriter()

    const result = await stage(
      new Map([
        [notionPinnedVersionFixture.caseId, recorderOf(notionPinnedVersionFixture.exchanges)],
        [notionTitlePlainTextFixture.caseId, recorderOf(notionTitlePlainTextFixture.exchanges)]
      ]),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail('expected staged recordings')
    }

    expect([...files.keys()].sort()).toEqual(
      [
        join(stagingDir, 'seeds.ts'),
        join(stagingDir, 'title-plain-text.ts'),
        join(stagingDir, 'pinned-version.ts')
      ].sort()
    )
    expect(files.get(join(stagingDir, 'seeds.ts'))).toBe(
      renderSeedsModule(notionRunner, notionConformanceFixtureSeeds)
    )

    const checklist = result.success.checklist.join('\n')

    // Titles, text, and workspace names are listed for review.
    expect(checklist).toContain('"Title Page"')
    expect(checklist).toContain('"Synthetic Workspace"')
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The pinned version is rejected: the claim no longer holds.
    const contradicted = notionPinnedVersionFixture.exchanges.map(exchange =>
      !isWireStreamResponse(exchange.response) && !isWireBase64BodyResponse(exchange.response)
        ? { ...exchange, response: { ...exchange.response, status: 400 } }
        : exchange
    )

    const result = await stage(
      new Map([[notionPinnedVersionFixture.caseId, recorderOf(contradicted)]]),
      writer
    )

    expect(Result.isFailure(result) ? result.failure.message : '').toBe(
      `${notionPinnedVersionFixture.caseId} did not pass on replay of its recording; nothing was written`
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

describe('run-notion-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { NOTION_API_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain(
      'SKIP  notion.pages.archive-in-trash  [write-reversible]  writes-not-allowed'
    )
  })

  it('refuses --live without --owner-approved', async () => {
    const result = await runCli(['--live', '--account', 'practice'], {
      NOTION_API_TOKEN: 'synthetic-token',
      CI: ''
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(ownerApprovalRequiredMessage)
  })
})
