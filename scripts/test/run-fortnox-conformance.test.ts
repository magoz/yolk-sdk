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
import { Deferred, Effect, Layer, Result } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireExchange,
  type WireFixture
} from '../../packages/conformance/src/fixture.ts'
import type { WireRecorderApi } from '../../packages/conformance/src/record.ts'
import { makeReplayHttpClient } from '../../packages/conformance/src/replay.ts'
import type { ConformanceReport } from '../../packages/conformance/src/runner.ts'
import {
  fortnoxConformanceCases,
  fortnoxConformanceFixtureSeeds,
  fortnoxConformanceFixtures,
  fortnoxInvoiceListPopulatedFixture,
  fortnoxInvoicePreviewPdfFixture,
  fortnoxInvoiceRowDiscountFixture,
  fortnoxWriteRejectionFixture
} from '../../packages/connectors/src/fortnox/conformance/index.ts'
import { FortnoxDocumentNumber } from '../../packages/connectors/src/fortnox/index.ts'
import {
  liveInCiMessage,
  nodeRecordingWriter,
  ownerApprovalRequiredMessage,
  recordingContainsAccessToken,
  redactedLiveTokenMarker,
  textContainsAccessToken,
  type CliIo,
  type CliSignal,
  type RecordingWriter,
  type SignalSource
} from '../connector-conformance-internal.ts'
import {
  accessTokenRequiredMessage,
  defaultRunOptions,
  dryRunReport,
  fortnoxCaseSpecs,
  fortnoxRecoveryAdvice,
  liveAccountRequiredMessage,
  liveInputs,
  liveTarget,
  mergedFixtureSeeds,
  parseRunArgs,
  planFortnoxRun,
  recordedTokenRefusal,
  recordingReviewChecklist,
  recordingRunId,
  recordingsRoot,
  renderFixtureModule,
  renderSeedsModule,
  renderedTokenRefusal,
  runFortnoxInterruptibly,
  runFortnoxLive,
  runFortnoxLiveCli,
  stageRecordings,
  type LiveInputs
} from '../run-fortnox-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-fortnox-conformance.ts')

const allSeedFlags = [
  '--discount-invoice=103',
  '--preview-invoice=102',
  '--customer=1001',
  '--missing-customer=99999',
  '--email-invoice=104',
  '--email-recipient=billing@example.test'
]

describe('run-fortnox-conformance arguments', () => {
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

  it('reads write policy, exact irreversible ids, record, and seeds from flags over env', () => {
    const options = parseRunArgs(
      [
        '--live',
        '--owner-approved',
        '--account=practice',
        '--allow-writes',
        'reversible',
        '--allow-irreversible',
        'fortnox.invoice.send-email',
        '--record',
        '--customer',
        '2002'
      ],
      {
        FORTNOX_CONFORMANCE_CUSTOMER: '1001',
        FORTNOX_CONFORMANCE_PREVIEW_INVOICE: ' 102 ',
        FORTNOX_CONFORMANCE_EMAIL_INVOICE: '',
        FORTNOX_CONFORMANCE_EMAIL_RECIPIENT: 'billing@example.test'
      }
    )

    expect(options).toEqual({
      live: true,
      help: false,
      record: true,
      ownerApproved: true,
      account: 'practice',
      allowWrites: 'reversible',
      allowIrreversible: ['fortnox.invoice.send-email'],
      seeds: {
        customerNumber: '2002',
        previewInvoiceDocumentNumber: '102',
        emailRecipient: 'billing@example.test'
      }
    })
  })

  it('rejects unknown flags, bad values, inexact case ids, and --record without --live', () => {
    expect(() => parseRunArgs(['--nope'])).toThrow('Unknown argument')
    expect(() => parseRunArgs(['--customer'])).toThrow('requires a value')
    expect(() => parseRunArgs(['--allow-writes=all'])).toThrow('none or reversible')
    expect(() => parseRunArgs(['--allow-irreversible', 'fortnox.invoice'])).toThrow(
      'exact write-irreversible case id'
    )
    expect(() =>
      parseRunArgs(['--allow-irreversible', 'fortnox.invoice.row-discount-sticky'])
    ).toThrow('exact write-irreversible case id')
    expect(() => parseRunArgs(['--record'])).toThrow('--record requires --live')
  })
})

describe('run-fortnox-conformance plan', () => {
  it('knows every case and its fixture module', () => {
    expect(fortnoxCaseSpecs.map(spec => spec.caseId)).toEqual(
      fortnoxConformanceCases.map(testCase => testCase.id)
    )
  })

  it('runs only read cases by default and keeps email manual-only for reversible writes', () => {
    const skips = (argv: ReadonlyArray<string>) =>
      planFortnoxRun(parseRunArgs(argv)).map(entry => [entry.id, entry.skipReason ?? 'runs'])

    expect(skips([])).toEqual([
      ['fortnox.invoice.list-populated', 'runs'],
      ['fortnox.invoice.preview-pdf', 'runs'],
      ['fortnox.invoice.payment-filters-exclude-unbooked', 'runs'],
      ['fortnox.invoice.row-discount-sticky', 'writes-not-allowed'],
      ['fortnox.customer.empty-string-keeps-value', 'writes-not-allowed'],
      ['fortnox.write.rejection-error-information', 'writes-not-allowed'],
      ['fortnox.invoice.send-email', 'manual-only']
    ])
    expect(skips(['--allow-writes', 'reversible']).at(-1)).toEqual([
      'fortnox.invoice.send-email',
      'manual-only'
    ])
    expect(skips(['--allow-writes', 'reversible']).slice(3, 6)).toEqual([
      ['fortnox.invoice.row-discount-sticky', 'runs'],
      ['fortnox.customer.empty-string-keeps-value', 'runs'],
      ['fortnox.write.rejection-error-information', 'runs']
    ])
    expect(skips(['--allow-irreversible=fortnox.invoice.send-email']).at(-1)).toEqual([
      'fortnox.invoice.send-email',
      'runs'
    ])
  })

  it('prints a dry-run plan with safety, skip reasons, and missing seeds', () => {
    const report = dryRunReport(parseRunArgs(['--allow-writes', 'reversible']))

    expect(report.split('\n')).toEqual([
      'DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to run (needs FORTNOX_ACCESS_TOKEN).',
      'Plan for a live target: allowWrites=reversible, allowIrreversible=[]',
      'RUN   fortnox.invoice.list-populated  [read]',
      'RUN   fortnox.invoice.preview-pdf  [read]  needs --preview-invoice',
      'RUN   fortnox.invoice.payment-filters-exclude-unbooked  [read]',
      'RUN   fortnox.invoice.row-discount-sticky  [write-reversible]  needs --discount-invoice',
      'RUN   fortnox.customer.empty-string-keeps-value  [write-reversible]  needs --customer',
      'RUN   fortnox.write.rejection-error-information  [write-reversible]  needs --missing-customer',
      'SKIP  fortnox.invoice.send-email  [write-irreversible]  manual-only',
      "Use a Fortnox developer test company only, with the repository owner's approval; never in CI. Row and customer write cases restore what they change; the rejection case writes only if Fortnox wrongly accepts it."
    ])
  })

  it('needs the email recipient seed before the email case can run', () => {
    const report = dryRunReport(
      parseRunArgs(['--allow-irreversible=fortnox.invoice.send-email', '--email-invoice=104'])
    )

    expect(report).toContain(
      'RUN   fortnox.invoice.send-email  [write-irreversible]  needs --email-recipient'
    )
  })
})

describe('run-fortnox-conformance live refusal (no network)', () => {
  const live = (argv: ReadonlyArray<string>) =>
    parseRunArgs(['--live', '--owner-approved', '--account', 'practice', ...argv])

  it('refuses in CI, without approval, an account, or an access token', () => {
    const env = { FORTNOX_ACCESS_TOKEN: 'synthetic-token' }

    expect(liveInputs(live(allSeedFlags), { ...env, CI: 'false' })).toEqual({
      refusal: liveInCiMessage
    })
    expect(liveInputs({ ...defaultRunOptions, live: true, account: 'practice' }, env)).toEqual({
      refusal: ownerApprovalRequiredMessage
    })
    expect(liveInputs({ ...defaultRunOptions, live: true, ownerApproved: true }, env)).toEqual({
      refusal: liveAccountRequiredMessage
    })
    expect(liveInputs(live(allSeedFlags), {})).toEqual({ refusal: accessTokenRequiredMessage })
    expect(liveInputs(live(allSeedFlags), { FORTNOX_ACCESS_TOKEN: '  ' })).toEqual({
      refusal: accessTokenRequiredMessage
    })
  })

  it('reads no credential when it refuses in CI, without approval, or without an account', () => {
    // An environment whose token getter counts every read.
    const counted = (extra: Readonly<Record<string, string>> = {}) => {
      let reads = 0
      const env = { ...extra }

      Object.defineProperty(env, 'FORTNOX_ACCESS_TOKEN', {
        enumerable: true,
        get: () => {
          reads += 1

          return 'synthetic-token'
        }
      })

      return { env, reads: () => reads }
    }

    const refusals = [
      [live(allSeedFlags), counted({ CI: 'false' })],
      [{ ...defaultRunOptions, live: true, account: 'practice' }, counted()],
      [{ ...defaultRunOptions, live: true, ownerApproved: true }, counted()]
    ] as const

    for (const [options, { env, reads }] of refusals) {
      expect(liveInputs(options, env)).toHaveProperty('refusal')
      expect(reads()).toBe(0)
    }

    // Parsing never reads it either, also when it refuses --live in CI.
    const parsing = counted({ CI: 'true' })

    expect(() =>
      parseRunArgs(['--live', '--owner-approved', '--account', 'practice'], parsing.env)
    ).toThrow(liveInCiMessage)
    expect(parsing.reads()).toBe(0)

    // The counter works: an accepted run reads the token once.
    const accepted = counted()

    expect(liveInputs(live(allSeedFlags), accepted.env)).toHaveProperty('inputs')
    expect(accepted.reads()).toBe(1)
  })

  it('refuses when a case that would run lacks its seed or a seed is invalid', () => {
    const env = { FORTNOX_ACCESS_TOKEN: 'synthetic-token' }

    expect(liveInputs(live([]), env)).toEqual({
      refusal: 'Missing seed identities for the cases that would run: --preview-invoice'
    })
    expect(liveInputs(live(['--preview-invoice', '..']), env)).toEqual({
      refusal:
        'Seed identities must be valid Fortnox document or customer numbers, and --email-recipient an email address'
    })
    expect(
      liveInputs(
        live([
          '--allow-irreversible=fortnox.invoice.send-email',
          '--preview-invoice=102',
          '--email-invoice=104',
          '--email-recipient=not an address'
        ]),
        env
      )
    ).toEqual({
      refusal:
        'Seed identities must be valid Fortnox document or customer numbers, and --email-recipient an email address'
    })

    const accepted = liveInputs(live(['--preview-invoice', '102']), env)

    expect(accepted).toMatchObject({
      inputs: {
        account: 'practice',
        accessToken: 'synthetic-token',
        seeds: { previewInvoiceDocumentNumber: '102' }
      }
    })
  })
})

describe('run-fortnox-conformance rendering', () => {
  it('renders the committed seeds module exactly', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages/connectors/src/fortnox/conformance/seeds.ts'),
      'utf8'
    )

    expect(renderSeedsModule(fortnoxConformanceFixtureSeeds)).toBe(committed)
  })

  it('merges only the seeds of recorded cases', () => {
    const merged = mergedFixtureSeeds(
      fortnoxConformanceFixtureSeeds,
      { previewInvoiceDocumentNumber: FortnoxDocumentNumber.make('1001') },
      ['fortnox.invoice.preview-pdf']
    )

    expect(merged).toEqual({
      ...fortnoxConformanceFixtureSeeds,
      previewInvoiceDocumentNumber: '1001'
    })
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const spec = fortnoxCaseSpecs.find(entry => entry.caseId === 'fortnox.invoice.preview-pdf')

    if (spec === undefined) {
      return expect.fail('missing preview spec')
    }

    const source = renderFixtureModule(spec, fortnoxInvoicePreviewPdfFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const fortnoxInvoicePreviewPdfFixture: WireFixture = {')
    expect(source).toContain(
      'pnpm conformance:fortnox --live --owner-approved --account <label> --record'
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
  startedAt: '2026-09-29T12:00:00.000Z',
  results: caseIds.map(id => ({
    id,
    safety: fortnoxConformanceCases.find(testCase => testCase.id === id)?.safety ?? 'read',
    status: 'passed',
    warnings: [],
    durationMs: 1
  })),
  summary: { passed: caseIds.length, failed: 0, skipped: 0 }
})

const recordInputs: LiveInputs = {
  account: 'practice',
  accessToken: 'synthetic-token',
  seeds: fortnoxConformanceFixtureSeeds
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

const runId = recordingRunId(new Date('2026-09-29T12:34:56.789Z'), 'a1b2c3d4')

const stagingDir = join(recordingsRoot, runId)

const tempDir = join(recordingsRoot, `.tmp-${runId}`)

const listId = fortnoxInvoiceListPopulatedFixture.caseId

const discountId = fortnoxInvoiceRowDiscountFixture.caseId

const listRecorders = () =>
  new Map([[listId, recorderOf(fortnoxInvoiceListPopulatedFixture.exchanges)]])

const previewId = fortnoxInvoicePreviewPdfFixture.caseId

/** An opaque live token: no Bearer prefix, not JWT-shaped, no known API-key prefix. */
const opaqueToken = 'opaque7c1d9e2b4a6f8e0d3c5b'

/** `opaqueToken` with an interior JSON Unicode escape (`\u0037` is `7`), as JSON text. */
const escapedOpaqueToken = `opaque\\u0037${opaqueToken.slice('opaque7'.length)}`

const stageWithToken = (
  recorders: ReadonlyMap<string, WireRecorderApi>,
  writer: RecordingWriter,
  accessToken: string = opaqueToken
) =>
  Effect.runPromise(
    stageRecordings(
      passedReport([...recorders.keys()]),
      recorders,
      { ...recordInputs, accessToken },
      { writer, stagingDir, recordedAt: '2026-09-29' }
    ).pipe(Effect.result)
  )

/** The list recording with `ExternalInvoiceReference1` set to `value` (raw JSON text). */
const listWithReference = (value: string): WireFixture['exchanges'] => {
  const [first, ...rest] = fortnoxInvoiceListPopulatedFixture.exchanges

  if (isWireStreamResponse(first.response) || isWireBase64BodyResponse(first.response)) {
    return expect.fail('expected a text list response')
  }

  expect(first.response.body).toContain('"ExternalInvoiceReference1":""')

  return [
    {
      ...first,
      response: {
        ...first.response,
        body: first.response.body.replace(
          '"ExternalInvoiceReference1":""',
          `"ExternalInvoiceReference1":"${value}"`
        )
      }
    },
    ...rest
  ]
}

const stage = (
  recorders: ReadonlyMap<string, WireRecorderApi>,
  writer: RecordingWriter,
  dir: string = stagingDir
) =>
  Effect.runPromise(
    stageRecordings(passedReport([...recorders.keys()]), recorders, recordInputs, {
      writer,
      stagingDir: dir,
      recordedAt: '2026-09-29'
    }).pipe(Effect.result)
  )

const failureMessage = (result: Awaited<ReturnType<typeof stage>>): string =>
  Result.isFailure(result) ? result.failure.message : expect.fail('expected a refusal')

describe('run-fortnox-conformance --record staging (offline)', () => {
  it('keeps the staging directory gitignored and outside committed sources', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')

    expect(gitignore.split('\n')).toContain('/.conformance-recordings/')
    expect(recordingsRoot).toBe(join(repoRoot, '.conformance-recordings', 'fortnox'))
  })

  it('names each run directory by UTC date, time, and a random suffix', () => {
    expect(runId).toBe('2026-09-29T123456Z-a1b2c3d4')
    expect(recordingRunId(new Date('2026-09-29T12:34:56.789Z'), 'e5f6a7b8')).not.toBe(runId)
  })

  it('writes the whole batch into a temp directory, then publishes it with one rename', async () => {
    const { writer, files, operations, entriesUnderRoot } = memoryWriter()

    const result = await stage(
      new Map([
        [listId, recorderOf(fortnoxInvoiceListPopulatedFixture.exchanges)],
        [discountId, recorderOf(fortnoxInvoiceRowDiscountFixture.exchanges)]
      ]),
      writer
    )

    if (Result.isFailure(result) || result.success === undefined) {
      return expect.fail('expected staged recordings')
    }

    const staged = [
      join(stagingDir, 'invoice-list-populated.ts'),
      join(stagingDir, 'invoice-row-discount.ts'),
      join(stagingDir, 'seeds.ts')
    ]

    expect(operations).toEqual([
      `mkdir ${tempDir}`,
      `write ${join(tempDir, 'invoice-list-populated.ts')}`,
      `write ${join(tempDir, 'invoice-row-discount.ts')}`,
      `write ${join(tempDir, 'seeds.ts')}`,
      `rename ${tempDir} -> ${stagingDir}`
    ])
    expect(entriesUnderRoot()).toEqual([stagingDir, ...staged].sort())
    expect(files.get(staged[0] ?? '')).toContain(`"id": "${listId}.recorded"`)
    expect(files.get(staged[0] ?? '')).toContain('"evidence": "verified"')
    expect(files.get(staged[0] ?? '')).toContain('"account": "practice"')
    expect(files.get(staged[2] ?? '')).toBe(renderSeedsModule(fortnoxConformanceFixtureSeeds))
    expect(result.success.stagingDir).toBe(stagingDir)
    expect(result.success.files).toEqual(staged)
    expect(result.success.checklist).toContain('  invoice-list-populated.ts:')
    expect(result.success.checklist.join('\n')).toContain('names: "Example Customer AB"')
    expect(result.success.checklist.at(-2)).toContain(
      'scrub, copy into packages/connectors/src/fortnox/conformance/'
    )
  })

  it('leaves no run directory and removes the temp directory when a write fails mid-batch', async () => {
    const { writer, operations, entriesUnderRoot } = memoryWriter({ failOnWrite: 1 })

    const result = await stage(
      new Map([
        [listId, recorderOf(fortnoxInvoiceListPopulatedFixture.exchanges)],
        [discountId, recorderOf(fortnoxInvoiceRowDiscountFixture.exchanges)]
      ]),
      writer
    )

    expect(failureMessage(result)).toBe(
      `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
    )
    expect(operations).toEqual([
      `mkdir ${tempDir}`,
      `write ${join(tempDir, 'invoice-list-populated.ts')}`,
      `write ${join(tempDir, 'invoice-row-discount.ts')}`,
      `rm ${tempDir}`
    ])
    expect(entriesUnderRoot()).toEqual([])
  })

  it('leaves no run directory when the publishing rename fails', async () => {
    const { writer, entriesUnderRoot } = memoryWriter({ failRename: true })

    const result = await stage(listRecorders(), writer)

    expect(failureMessage(result)).toBe(
      `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
    )
    expect(entriesUnderRoot()).toEqual([])
  })

  it('stages two same-day runs in two distinct directories', async () => {
    const { writer, entriesUnderRoot } = memoryWriter()

    const first = join(recordingsRoot, recordingRunId(new Date('2026-09-29T09:00:00Z'), 'aaaa1111'))

    const second = join(
      recordingsRoot,
      recordingRunId(new Date('2026-09-29T15:30:00Z'), 'bbbb2222')
    )

    expect(Result.isSuccess(await stage(listRecorders(), writer, first))).toBe(true)
    expect(Result.isSuccess(await stage(listRecorders(), writer, second))).toBe(true)
    expect(entriesUnderRoot()).toEqual(
      [
        first,
        join(first, 'invoice-list-populated.ts'),
        join(first, 'seeds.ts'),
        second,
        join(second, 'invoice-list-populated.ts'),
        join(second, 'seeds.ts')
      ].sort()
    )
  })

  it('refuses an existing run directory and writes nothing', async () => {
    const { writer, operations } = memoryWriter()

    writer.mkdir(stagingDir)
    operations.length = 0

    const result = await stage(listRecorders(), writer)

    expect(failureMessage(result)).toBe(`Refusing to overwrite ${stagingDir}; nothing was written`)
    expect(operations).toEqual([])
  })

  it('writes nothing when any recording fails replay verification', async () => {
    const { writer, operations } = memoryWriter()

    // The row-discount recording no longer supports its claim: the omitted discount reset to 0.
    const contradicted = fortnoxInvoiceRowDiscountFixture.exchanges.map((exchange, index) =>
      index === 4 &&
      !isWireStreamResponse(exchange.response) &&
      !isWireBase64BodyResponse(exchange.response)
        ? {
            ...exchange,
            response: {
              status: exchange.response.status,
              headers: exchange.response.headers,
              body: exchange.response.body.replace('"Discount":10,', '"Discount":0,')
            }
          }
        : exchange
    )

    const result = await stage(
      new Map([
        [listId, recorderOf(fortnoxInvoiceListPopulatedFixture.exchanges)],
        [discountId, recorderOf(contradicted)]
      ]),
      writer
    )

    expect(failureMessage(result)).toBe(
      `${discountId} did not pass on replay of its recording; nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when a recording fails the secret scan', async () => {
    const { writer, operations } = memoryWriter()
    const [first, ...rest] = fortnoxInvoiceListPopulatedFixture.exchanges

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

    const result = await stage(new Map([[listId, recorderOf(leaky)]]), writer)

    expect(failureMessage(result)).toBe(
      `${listId}: recording rejected (WireFixtureSecretsFound); nothing was written`
    )
    expect(operations).toEqual([])
  })

  // An opaque (not JWT-shaped) token in an innocuous field, raw or with an interior JSON escape
  // (which rendering escapes again): the secret scan cannot see it, and the field is not listed
  // for review. The recorded exchanges are searched before anything is rendered.
  for (const [label, value] of [
    ['verbatim', opaqueToken],
    ['with an interior Unicode escape', escapedOpaqueToken]
  ] as const) {
    it(`writes nothing when a JSON body field echoes the live access token ${label}`, async () => {
      const { writer, operations } = memoryWriter()
      const echoed = listWithReference(value)

      expect(recordingContainsAccessToken(echoed, opaqueToken)).toBe(true)

      const result = await stageWithToken(new Map([[listId, recorderOf(echoed)]]), writer)

      expect(failureMessage(result)).toBe(recordedTokenRefusal)
      expect(operations).toEqual([])
    })
  }

  it('the rendered-text check alone also finds the doubly escaped token', () => {
    const spec = fortnoxCaseSpecs.find(entry => entry.caseId === listId) ?? expect.fail('spec')

    const rendered = renderFixtureModule(spec, {
      ...fortnoxInvoiceListPopulatedFixture,
      exchanges: listWithReference(escapedOpaqueToken)
    })

    expect(rendered).toContain(`opaque\\\\u0037`)
    expect(textContainsAccessToken(rendered, opaqueToken)).toBe(true)
  })

  it('still refuses rendered files that carry the token when the recordings do not', async () => {
    const { writer, operations } = memoryWriter()

    // Only the rendered seeds module carries this value (the committed missing-customer seed).
    const seedValue = fortnoxConformanceFixtureSeeds.missingCustomerNumber ?? expect.fail('seed')

    expect(
      recordingContainsAccessToken(fortnoxInvoiceListPopulatedFixture.exchanges, seedValue)
    ).toBe(false)

    const result = await stageWithToken(listRecorders(), writer, seedValue)

    expect(failureMessage(result)).toBe(renderedTokenRefusal)
    expect(operations).toEqual([])
  })

  it('writes nothing when the preview PDF bytes carry the live access token', async () => {
    const { writer, operations } = memoryWriter()
    const [first, ...rest] = fortnoxInvoicePreviewPdfFixture.exchanges

    if (!isWireBase64BodyResponse(first.response)) {
      return expect.fail('expected a base64 PDF response')
    }

    // A PDF comment line carrying the token, after the header: still a complete PDF on replay.
    const pdf = Buffer.from(first.response.bodyBase64, 'base64')
    const header = pdf.indexOf(0x0a) + 1

    const leaky = Buffer.concat([
      pdf.subarray(0, header),
      Buffer.from(`%${opaqueToken}\n`),
      pdf.subarray(header)
    ])

    const echoed: ReadonlyArray<WireExchange> = [
      { ...first, response: { ...first.response, bodyBase64: leaky.toString('base64') } },
      ...rest
    ]

    // Not strict UTF-8, so the bytes are searched as text instead of refusing the PDF.
    expect(recordingContainsAccessToken(echoed, opaqueToken)).toBe(true)

    const result = await stageWithToken(new Map([[previewId, recorderOf(echoed)]]), writer)

    expect(failureMessage(result)).toBe(recordedTokenRefusal)
    expect(operations).toEqual([])
  })

  it('stages a preview PDF recording that does not carry the token', async () => {
    const { writer, files } = memoryWriter()

    const result = await stageWithToken(
      new Map([[previewId, recorderOf(fortnoxInvoicePreviewPdfFixture.exchanges)]]),
      writer
    )

    expect(Result.isSuccess(result)).toBe(true)
    expect(files.get(join(stagingDir, 'invoice-preview-pdf.ts'))).toContain('"bodyBase64"')
  })

  it('refuses a staging directory that is not a direct child of the recordings root', async () => {
    for (const dir of [
      join(repoRoot, 'packages/connectors/src/fortnox/conformance'),
      join(repoRoot, '.conformance-recordings', 'other', runId),
      join(stagingDir, 'nested'),
      join(recordingsRoot, '..', runId),
      recordingsRoot,
      tempDir
    ]) {
      const { writer, operations } = memoryWriter()

      const result = await stage(listRecorders(), writer, dir)

      expect(failureMessage(result)).toBe(
        `Refusing to stage recordings outside the recordings root (${recordingsRoot}); nothing was written`
      )
      expect(operations).toEqual([])
    }
  })

  it('refuses a recordings root inside committed package sources', async () => {
    const { writer, operations } = memoryWriter()
    const root = join(repoRoot, 'packages/connectors/src/fortnox/conformance/recordings')

    const result = await Effect.runPromise(
      stageRecordings(passedReport([...listRecorders().keys()]), listRecorders(), recordInputs, {
        writer,
        recordingsRoot: root,
        stagingDir: join(root, runId),
        recordedAt: '2026-09-29'
      }).pipe(Effect.result)
    )

    expect(failureMessage(result)).toBe(
      `Refusing a recordings root inside committed package sources (${root}); nothing was written`
    )
    expect(operations).toEqual([])
  })

  it('writes nothing when no case passed', async () => {
    const { writer, operations } = memoryWriter()

    const result = await stage(new Map(), writer)

    expect(result).toMatchObject({ _tag: 'Success', success: undefined })
    expect(operations).toEqual([])
  })

  it('lists foreign emails, names, Comments values, and PDF bodies for review', () => {
    const fixtureFor = (id: string): WireFixture =>
      fortnoxConformanceFixtures.find(fixture => fixture.caseId === id) ??
      expect.fail(`missing ${id}`)

    const [first, ...rest] = fixtureFor('fortnox.customer.empty-string-keeps-value').exchanges

    const customer: WireFixture = {
      ...fixtureFor('fortnox.customer.empty-string-keeps-value'),
      exchanges: [
        {
          ...first,
          response: {
            status: 200,
            headers: {},
            body: '{"Customer":{"Name":"Example Customer AB","Email":"person@practice.invalid","EmailInvoice":"billing@example.test","Comments":"Synthetic note"}}'
          }
        },
        ...rest
      ]
    }

    const specOf = (caseId: string) =>
      fortnoxCaseSpecs.find(spec => spec.caseId === caseId) ?? expect.fail(`missing ${caseId}`)

    const checklist = recordingReviewChecklist([
      { spec: specOf(customer.caseId), fixture: customer },
      {
        spec: specOf(fortnoxInvoicePreviewPdfFixture.caseId),
        fixture: fortnoxInvoicePreviewPdfFixture
      }
    ]).join('\n')

    expect(checklist).toContain(
      'emails outside example.test/example.com: "person@practice.invalid"'
    )
    expect(checklist).not.toContain('"billing@example.test"')
    expect(checklist).toContain('names: "Example Customer AB"')
    expect(checklist).toContain('Comments values: "Synthetic note"')
    expect(checklist).toContain('invoice-preview-pdf.ts:')
    expect(checklist).toContain('1 binary body (PDF): open it and check the rendered document')
  })
})

describe('run-fortnox-conformance --record containment (real filesystem)', () => {
  const stageUnder = (base: string) => {
    const root = join(base, '.conformance-recordings', 'fortnox')

    return {
      root,
      result: Effect.runPromise(
        stageRecordings(passedReport([listId]), listRecorders(), recordInputs, {
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
      expect(readdirSync(join(root, runId)).sort()).toEqual([
        'invoice-list-populated.ts',
        'seeds.ts'
      ])
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

    expect(failureMessage(await stage(listRecorders(), swapping))).toBe(
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

const exchangeAt = (fixture: WireFixture, index: number): WireExchange =>
  fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

/** `exchange` with `from` replaced by `to` in its text response body. */
const withTextBody = (exchange: WireExchange, from: string, to: string): WireExchange => {
  const { response } = exchange

  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text response body')
  }

  expect(response.body).toContain(from)

  return { ...exchange, response: { ...response, body: response.body.replace(from, to) } }
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
        Effect.andThen(Effect.sync(() => cleaned.push('restored')))
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

describe('run-fortnox-conformance live runs are interruptible', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`interrupts the run on ${signal}, lets the restore finish, and exits 130 with Fortnox advice`, async () => {
      const signals = fakeSignals()
      const { io, errors, exitCodes, forcedExits } = fakeIo()
      const running = runningProgram()
      const done = runFortnoxInterruptibly(running.program, signals.source, io, { pid: 4242 })

      await running.started
      signals.emit(signal)
      running.releaseCleanup()
      await done

      expect(running.cleaned).toEqual(['restored'])
      expect(errors[0]).toContain(
        `${signal}: interrupting the run (pid 4242); the running case's cleanup is attempted before exit`
      )
      expect(errors.at(-1)).toBe(`Interrupted. Read the WARN lines. ${fortnoxRecoveryAdvice}`)
      // Fortnox cases create no items to look for: the advice names the changed records instead.
      expect(errors.join('\n')).not.toContain('yolk-conformance items')
      expect(fortnoxRecoveryAdvice).toContain('Comments equal to "yolk-conformance marker')
      expect(fortnoxRecoveryAdvice).toContain('a Discount of 10 or 0')
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

    const done = runFortnoxInterruptibly(running.program, signals.source, io, {
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
      `Second SIGINT: exiting now without waiting for cleanup. ${fortnoxRecoveryAdvice}`
    )

    running.releaseCleanup()
    await done
  })

  it('prints the case-specific WARN when a real row case is interrupted and its restore fails', async () => {
    const signals = fakeSignals()
    const { io, errors, exitCodes, forcedExits } = fakeIo()
    const out: Array<string> = []
    const sent = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())

    // The row case's first PUT is held; after it only the restore's PUT (7) and read-back (8)
    // follow, and the read-back no longer shows the original rows, so the restore fails.
    const discount = fortnoxInvoiceRowDiscountFixture

    const unrestored: WireFixture = {
      ...discount,
      exchanges: [
        exchangeAt(discount, 0),
        exchangeAt(discount, 1),
        exchangeAt(discount, 7),
        withTextBody(exchangeAt(discount, 8), '"Discount":5,', '"Discount":0,')
      ]
    }

    const { client } = await Effect.runPromise(
      makeReplayHttpClient(
        fortnoxConformanceFixtures.map(fixture =>
          fixture.id === fortnoxInvoiceRowDiscountFixture.id ? unrestored : fixture
        )
      )
    )

    let puts = 0

    const holding = HttpClient.transform(client, (response, request) =>
      request.method === 'PUT' && ++puts === 1
        ? response.pipe(
            Effect.tap(() => Deferred.succeed(sent, undefined)),
            Effect.tap(() => Deferred.await(release))
          )
        : response
    )

    const done = runFortnoxInterruptibly(
      runFortnoxLive(
        {
          ...defaultRunOptions,
          live: true,
          ownerApproved: true,
          account: 'practice',
          allowWrites: 'reversible'
        },
        recordInputs,
        {
          http: Layer.succeed(HttpClient.HttpClient, holding),
          out: line => out.push(line),
          // stderr: the WARN lines share the stream with the runner's own messages.
          err: line => io.error(line)
        }
      ),
      signals.source,
      io,
      { pid: 4242 }
    )

    await Effect.runPromise(Deferred.await(sent))
    signals.emit('SIGINT')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    Effect.runSync(Deferred.succeed(release, undefined))
    await done

    const restoreFailed =
      'fortnox.invoice.row-discount-sticky: restore failed; restore the account by hand if it still differs from its original state. Restore error: expected the original invoice rows back after restoring. Claim failed first: interrupted'

    expect(errors[0]).toContain('SIGINT: interrupting the run (pid 4242)')
    expect(errors).toContain(`WARN ${restoreFailed}`)
    expect(errors.filter(line => line.startsWith('WARN '))).toEqual([`WARN ${restoreFailed}`])
    // The run ends with the case's own RestoreFailed (not interrupt-only): exit 1, no report.
    expect(errors.at(-1)).toBe(restoreFailed)
    expect(exitCodes).toEqual([1])
    expect(forcedExits).toEqual([])
    expect(out).toEqual([])
    expect(signals.registered()).toBe(0)
  })

  it('reports a failed run with exit code 1 and no signal handlers left behind', async () => {
    const signals = fakeSignals()
    const { io, errors, exitCodes } = fakeIo()

    await runFortnoxInterruptibly(
      Effect.fail(new Error('synthetic live failure')),
      signals.source,
      io
    )

    expect(errors).toEqual(['synthetic live failure'])
    expect(exitCodes).toEqual([1])
    expect(signals.registered()).toBe(0)
  })
})

describe('run-fortnox-conformance live output is redacted of the live token', () => {
  const liveToken = 'SyntheticFortnoxLiveAccessToken0000000000000001'
  const rejectionId = 'fortnox.write.rejection-error-information'

  // Fortnox wrongly accepts the rejected create and answers with an invoice whose DocumentNumber
  // echoes the token: the rejection case reports that number in its failure, which the report
  // prints.
  const acceptedWith = (documentNumber: string): WireFixture => {
    const rejected = exchangeAt(fortnoxWriteRejectionFixture, 1)

    return {
      ...fortnoxWriteRejectionFixture,
      exchanges: [
        exchangeAt(fortnoxWriteRejectionFixture, 0),
        {
          ...rejected,
          response: {
            status: 201,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              Invoice: { DocumentNumber: documentNumber, CustomerNumber: '99999' }
            })
          }
        }
      ]
    }
  }

  for (const [label, echoed] of [
    ['raw', liveToken],
    ['base64-encoded', Buffer.from(`x${liveToken}`).toString('base64')]
  ] as const) {
    it(`prints no trace of a ${label} token echoed in a reported field to stdout or stderr`, async () => {
      const { client } = await Effect.runPromise(
        makeReplayHttpClient(
          fortnoxConformanceFixtures.map(fixture =>
            fixture.id === fortnoxWriteRejectionFixture.id ? acceptedWith(echoed) : fixture
          )
        )
      )

      const stdout: Array<string> = []
      const stderr: Array<string> = []
      const signals = fakeSignals()
      const { io, errors, exitCodes } = fakeIo()
      const exitCode = process.exitCode

      try {
        // The CLI's own entry: the run's lines and its CLI messages, each through the redaction.
        await runFortnoxLiveCli(
          {
            ...defaultRunOptions,
            live: true,
            ownerApproved: true,
            account: 'practice',
            allowWrites: 'reversible'
          },
          { ...recordInputs, accessToken: liveToken },
          signals.source,
          io,
          {
            http: Layer.succeed(HttpClient.HttpClient, client),
            out: line => stdout.push(line),
            err: line => stderr.push(line)
          }
        )
      } finally {
        // A failed report sets the exit code of this process; keep the test run's own.
        process.exitCode = exitCode
      }

      const printedOut = stdout.join('\n')
      const printedErr = [...stderr, ...errors].join('\n')

      expect(printedOut).toContain(`FAIL  ${rejectionId}`)
      expect(printedOut).toContain('but Fortnox created invoice ')
      expect(printedOut).toContain(redactedLiveTokenMarker)
      expect(textContainsAccessToken(printedOut, liveToken)).toBe(false)
      expect(textContainsAccessToken(printedErr, liveToken)).toBe(false)
      expect(printedOut).not.toContain(echoed)
      expect(printedErr).not.toContain(echoed)
      expect(exitCodes).toEqual([])
      expect(signals.registered()).toBe(0)
    })
  }

  it('prints no trace of a token echoed in an interrupted restore failure (WARN and run failure on stderr)', async () => {
    const signals = fakeSignals()
    const { io, errors, exitCodes, forcedExits } = fakeIo()
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const sent = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())

    const { client } = await Effect.runPromise(makeReplayHttpClient(fortnoxConformanceFixtures))

    let puts = 0

    // The row case's first PUT is held until the interruption; its restore PUT then fails with the
    // token in the failure message, which the case's RestoreFailed summarizes: printed as the WARN
    // line (the run's err) and as the run's own failure (the CLI io), both on stderr.
    const echoing = HttpClient.transform(client, (response, request) => {
      if (request.method !== 'PUT') return response

      puts += 1

      return puts === 1
        ? response.pipe(
            Effect.tap(() => Deferred.succeed(sent, undefined)),
            Effect.tap(() => Deferred.await(release))
          )
        : Effect.die(new Error(liveToken))
    })

    const done = runFortnoxLiveCli(
      {
        ...defaultRunOptions,
        live: true,
        ownerApproved: true,
        account: 'practice',
        allowWrites: 'reversible'
      },
      { ...recordInputs, accessToken: liveToken },
      signals.source,
      io,
      {
        http: Layer.succeed(HttpClient.HttpClient, echoing),
        out: line => stdout.push(line),
        err: line => stderr.push(line)
      },
      { pid: 4242 }
    )

    await Effect.runPromise(Deferred.await(sent))
    signals.emit('SIGINT')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    Effect.runSync(Deferred.succeed(release, undefined))
    await done

    const warns = stderr.filter(line => line.startsWith('WARN '))

    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('fortnox.invoice.row-discount-sticky: restore failed')
    expect(warns[0]).toContain(redactedLiveTokenMarker)
    expect(errors.at(-1)).toContain('fortnox.invoice.row-discount-sticky: restore failed')
    expect(errors.at(-1)).toContain(redactedLiveTokenMarker)
    expect(textContainsAccessToken([...stdout, ...stderr, ...errors].join('\n'), liveToken)).toBe(
      false
    )
    expect(exitCodes).toEqual([1])
    expect(forcedExits).toEqual([])
    expect(stdout).toEqual([])
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

describe('run-fortnox-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await runCli([], { FORTNOX_ACCESS_TOKEN: '', CI: '' })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain('SKIP  fortnox.invoice.send-email  [write-irreversible]')
  })

  it('refuses --live in CI before reading any token', async () => {
    const result = await runCli(['--live', '--owner-approved', '--account', 'practice'], {
      FORTNOX_ACCESS_TOKEN: 'synthetic-token',
      CI: 'true'
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(liveInCiMessage)
  })

  it('refuses --live without --owner-approved before reading any token', async () => {
    const result = await runCli(['--live', '--account', 'practice'], {
      FORTNOX_ACCESS_TOKEN: 'synthetic-token',
      CI: ''
    })

    expect(result.failed).toBe(true)
    expect(result.stderr).toContain(ownerApprovalRequiredMessage)
  })
})
