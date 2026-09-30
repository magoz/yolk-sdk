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
  fortnoxConformanceCases,
  fortnoxConformanceFixtureSeeds,
  fortnoxConformanceFixtures,
  fortnoxInvoiceListPopulatedFixture,
  fortnoxInvoicePreviewPdfFixture,
  fortnoxInvoiceRowDiscountFixture
} from '../../packages/connectors/src/fortnox/conformance/index.ts'
import { FortnoxDocumentNumber } from '../../packages/connectors/src/fortnox/index.ts'
import {
  accessTokenRequiredMessage,
  defaultRunOptions,
  dryRunReport,
  fortnoxCaseSpecs,
  liveAccountRequiredMessage,
  liveInputs,
  liveTarget,
  mergedFixtureSeeds,
  parseRunArgs,
  planFortnoxRun,
  recordingReviewChecklist,
  recordingsRoot,
  renderFixtureModule,
  renderSeedsModule,
  stageRecordings,
  type LiveInputs,
  type RecordingWriter
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
  it('defaults to a dry run with no writes, no account, and no seeds', () => {
    expect(parseRunArgs([])).toEqual(defaultRunOptions)
    expect(liveTarget(defaultRunOptions)).toEqual({
      kind: 'live',
      account: 'dry-run',
      allowWrites: 'none',
      allowIrreversible: []
    })
  })

  it('requires an explicit synthetic --account label with --live', () => {
    expect(() => parseRunArgs(['--live'])).toThrow(liveAccountRequiredMessage)
    expect(() => parseRunArgs(['--live', '--account', 'Example Person'])).toThrow(
      '--account must be a short synthetic label'
    )
    expect(parseRunArgs(['--live', '--account', 'practice'])).toMatchObject({
      live: true,
      account: 'practice'
    })
    expect(parseRunArgs(['--live', '--help']).help).toBe(true)
  })

  it('reads write policy, exact irreversible ids, record, and seeds from flags over env', () => {
    const options = parseRunArgs(
      [
        '--live',
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
      'DRY RUN: no network request was made. Pass --live --account <label> to run (needs FORTNOX_ACCESS_TOKEN).',
      'Plan for a live target: allowWrites=reversible, allowIrreversible=[]',
      'RUN   fortnox.invoice.list-populated  [read]',
      'RUN   fortnox.invoice.preview-pdf  [read]  needs --preview-invoice',
      'RUN   fortnox.invoice.payment-filters-exclude-unbooked  [read]',
      'RUN   fortnox.invoice.row-discount-sticky  [write-reversible]  needs --discount-invoice',
      'RUN   fortnox.customer.empty-string-keeps-value  [write-reversible]  needs --customer',
      'RUN   fortnox.write.rejection-error-information  [write-reversible]  needs --missing-customer',
      'SKIP  fortnox.invoice.send-email  [write-irreversible]  manual-only',
      'Use a Fortnox developer test company only. Row and customer write cases restore what they change; the rejection case writes only if Fortnox wrongly accepts it.'
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
    parseRunArgs(['--live', '--account', 'practice', ...argv])

  it('refuses without an account or an access token', () => {
    expect(liveInputs({ ...defaultRunOptions, live: true }, {})).toEqual({
      refusal: liveAccountRequiredMessage
    })
    expect(liveInputs(live(allSeedFlags), {})).toEqual({ refusal: accessTokenRequiredMessage })
    expect(liveInputs(live(allSeedFlags), { FORTNOX_ACCESS_TOKEN: '  ' })).toEqual({
      refusal: accessTokenRequiredMessage
    })
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
    expect(source).toContain('pnpm conformance:fortnox --live --account <label> --record')
  })
})

// Offline `--record` gate: fake recorders hand back synthetic exchanges; a fake writer records
// every write. Nothing touches the filesystem or the network.

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

const fakeWriter = () => {
  const writes: Array<{ readonly path: string; readonly contents: string }> = []
  const directories: Array<string> = []

  const writer: RecordingWriter = {
    makeDirectory: path => {
      directories.push(path)
    },
    writeFile: (path, contents) => {
      writes.push({ path, contents })
    }
  }

  return { writer, writes, directories }
}

const stagingDir = join(recordingsRoot, '2026-09-29')

const listId = fortnoxInvoiceListPopulatedFixture.caseId

const discountId = fortnoxInvoiceRowDiscountFixture.caseId

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

  it('writes every verified recording and the seeds only to the staging directory', async () => {
    const { writer, writes, directories } = fakeWriter()

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

    expect(directories).toEqual([stagingDir])
    expect(writes.map(write => write.path)).toEqual([
      join(stagingDir, 'invoice-list-populated.ts'),
      join(stagingDir, 'invoice-row-discount.ts'),
      join(stagingDir, 'seeds.ts')
    ])
    expect(writes.every(write => write.path.startsWith(`${stagingDir}/`))).toBe(true)
    expect(writes[0]?.contents).toContain(`"id": "${listId}.recorded"`)
    expect(writes[0]?.contents).toContain('"evidence": "verified"')
    expect(writes[0]?.contents).toContain('"account": "practice"')
    expect(writes[2]?.contents).toBe(renderSeedsModule(fortnoxConformanceFixtureSeeds))
    expect(result.success.files).toEqual(writes.map(write => write.path))
    expect(result.success.checklist).toContain('  invoice-list-populated.ts:')
    expect(result.success.checklist.join('\n')).toContain('names: "Example Customer AB"')
    expect(result.success.checklist.at(-2)).toContain(
      'scrub, copy into packages/connectors/src/fortnox/conformance/'
    )
  })

  it('writes nothing when any recording fails replay verification', async () => {
    const { writer, writes, directories } = fakeWriter()

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
    expect(writes).toEqual([])
    expect(directories).toEqual([])
  })

  it('writes nothing when a recording fails the secret scan', async () => {
    const { writer, writes, directories } = fakeWriter()
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
    expect(writes).toEqual([])
    expect(directories).toEqual([])
  })

  it('refuses a staging directory inside the committed package sources', async () => {
    const { writer, writes } = fakeWriter()

    const result = await stage(
      new Map([[listId, recorderOf(fortnoxInvoiceListPopulatedFixture.exchanges)]]),
      writer,
      join(repoRoot, 'packages/connectors/src/fortnox/conformance')
    )

    expect(failureMessage(result)).toContain(
      'Refusing to stage recordings inside committed sources'
    )
    expect(writes).toEqual([])
  })

  it('writes nothing when no case passed', async () => {
    const { writer, writes } = fakeWriter()

    const result = await stage(new Map(), writer)

    expect(result).toMatchObject({ _tag: 'Success', success: undefined })
    expect(writes).toEqual([])
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

describe('run-fortnox-conformance CLI', () => {
  it('dry-runs by default without a token', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, runnerScript],
        { cwd: repoRoot, env: { ...process.env, FORTNOX_ACCESS_TOKEN: '' } },
        (error, stdout) => {
          resolvePromise({ failed: error !== null, stdout: String(stdout) })
        }
      )
    })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
    expect(result.stdout).toContain('SKIP  fortnox.invoice.send-email  [write-irreversible]')
  })
})
