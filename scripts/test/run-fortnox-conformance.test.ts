import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  fortnoxConformanceCases,
  fortnoxConformanceFixtureSeeds,
  fortnoxInvoicePreviewPdfFixture
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
  renderFixtureModule,
  renderSeedsModule
} from '../run-fortnox-conformance.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const runnerScript = join(repoRoot, 'scripts/run-fortnox-conformance.ts')

const allSeedFlags = [
  '--discount-invoice=103',
  '--preview-invoice=102',
  '--customer=1001',
  '--missing-customer=99999',
  '--email-invoice=104'
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
        FORTNOX_CONFORMANCE_EMAIL_INVOICE: ''
      }
    )

    expect(options).toEqual({
      live: true,
      help: false,
      record: true,
      account: 'practice',
      allowWrites: 'reversible',
      allowIrreversible: ['fortnox.invoice.send-email'],
      seeds: { customerNumber: '2002', previewInvoiceDocumentNumber: '102' }
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
      'Use a Fortnox developer test company only. Write cases restore what they change.'
    ])
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
      refusal: 'Seed identities must be valid Fortnox document or customer numbers'
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
