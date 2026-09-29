/**
 * Fortnox conformance runner for a Fortnox developer test company ("practice account").
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call.
 *
 * `--live --account <label>`: runs the cases against the real Fortnox API with a `FetchHttpClient`
 * through the real connector actions. Requires `FORTNOX_ACCESS_TOKEN` (environment only, never a
 * flag) and the seed identities of every case that will run (flags or environment, see `usage`).
 * The label is synthetic and non-identifying (for example `practice`): it is printed in reports
 * and committed in recorded fixtures. Read cases always run; `--allow-writes reversible` adds the
 * write-reversible cases (they restore what they change); `--allow-irreversible <case-id>`
 * (repeatable, exact ids) is the only way to run a write-irreversible case such as sending an
 * invoice email.
 *
 * `--record` (with `--live`) wraps the live client with the conformance `WireRecorder`. After the
 * run it builds `verified` fixtures (today's date, the account label) for the cases that passed,
 * re-runs each case on replay against its new fixture, and rewrites the fixture modules and the
 * fixture seeds under `packages/connectors/src/fortnox/conformance/` only if every recorded case
 * verified and passed the secret scan. Review the rewritten fixtures before committing: they
 * contain practice-company data.
 *
 * Never run live in CI.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Option, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import type { ConformanceSafety } from '../packages/conformance/src/case.ts'
import type { WireFixture } from '../packages/conformance/src/fixture.ts'
import {
  makeRecordingHttpClient,
  makeWireFixture,
  type WireRecorderApi
} from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceSkipReason,
  type ConformanceTarget
} from '../packages/conformance/src/runner.ts'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { OAuthCredential } from '../packages/connectors/src/credential.ts'
import {
  FortnoxConformanceConfig,
  FortnoxConformanceSeeds,
  fortnoxConformanceCases,
  fortnoxConformanceFixtureSeeds,
  type FortnoxConformanceCase,
  type FortnoxConformanceSeedKey
} from '../packages/connectors/src/fortnox/conformance/index.ts'
import { fortnoxApiBaseUrl } from '../packages/connectors/src/fortnox/index.ts'

type SeedSource = {
  readonly key: FortnoxConformanceSeedKey
  readonly flag: string
  readonly env: string
  readonly kind: 'document' | 'customer'
  readonly description: string
}

/** Where each seed identity comes from. Flags win over environment variables. */
export const fortnoxSeedSources: ReadonlyArray<SeedSource> = [
  {
    key: 'discountInvoiceDocumentNumber',
    flag: '--discount-invoice',
    env: 'FORTNOX_CONFORMANCE_DISCOUNT_INVOICE',
    kind: 'document',
    description:
      'unbooked invoice with at least one row, every row DiscountType PERCENT (rows changed, then restored)'
  },
  {
    key: 'previewInvoiceDocumentNumber',
    flag: '--preview-invoice',
    env: 'FORTNOX_CONFORMANCE_PREVIEW_INVOICE',
    kind: 'document',
    description: 'any invoice with a downloadable preview PDF'
  },
  {
    key: 'customerNumber',
    flag: '--customer',
    env: 'FORTNOX_CONFORMANCE_CUSTOMER',
    kind: 'customer',
    description: 'customer with a non-empty Comments value (changed, then restored)'
  },
  {
    key: 'missingCustomerNumber',
    flag: '--missing-customer',
    env: 'FORTNOX_CONFORMANCE_MISSING_CUSTOMER',
    kind: 'customer',
    description: 'customer number that does NOT exist'
  },
  {
    key: 'emailInvoiceDocumentNumber',
    flag: '--email-invoice',
    env: 'FORTNOX_CONFORMANCE_EMAIL_INVOICE',
    kind: 'document',
    description: 'invoice to send by email (irreversible; manual only)'
  }
]

export type FortnoxCaseSpec = {
  readonly caseId: string
  readonly seeds: ReadonlyArray<FortnoxConformanceSeedKey>
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
}

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const fortnoxCaseSpecs: ReadonlyArray<FortnoxCaseSpec> = [
  {
    caseId: 'fortnox.invoice.list-populated',
    seeds: [],
    fileName: 'invoice-list-populated.ts',
    exportName: 'fortnoxInvoiceListPopulatedFixture',
    doc: 'One page of a populated invoice list with `MetaInformation`.'
  },
  {
    caseId: 'fortnox.invoice.preview-pdf',
    seeds: ['previewInvoiceDocumentNumber'],
    fileName: 'invoice-preview-pdf.ts',
    exportName: 'fortnoxInvoicePreviewPdfFixture',
    doc: 'Generated invoice preview PDF (`bodyBase64`).'
  },
  {
    caseId: 'fortnox.invoice.payment-filters-exclude-unbooked',
    seeds: [],
    fileName: 'invoice-payment-filters.ts',
    exportName: 'fortnoxInvoicePaymentFiltersFixture',
    doc: 'Invoice lists for `filter=unbooked`, `filter=unpaid`, and `filter=unpaidoverdue`.'
  },
  {
    caseId: 'fortnox.invoice.row-discount-sticky',
    seeds: ['discountInvoiceDocumentNumber'],
    fileName: 'invoice-row-discount.ts',
    exportName: 'fortnoxInvoiceRowDiscountFixture',
    doc: 'Positional invoice-row updates (set, omit, clear Discount), then the restore and its read-back.'
  },
  {
    caseId: 'fortnox.customer.empty-string-keeps-value',
    seeds: ['customerNumber'],
    fileName: 'customer-empty-string.ts',
    exportName: 'fortnoxCustomerEmptyStringFixture',
    doc: 'Customer `Comments` updates (marker, empty string), then the restore and its read-back.'
  },
  {
    caseId: 'fortnox.write.rejection-error-information',
    seeds: ['missingCustomerNumber'],
    fileName: 'write-rejection.ts',
    exportName: 'fortnoxWriteRejectionFixture',
    doc: 'A missing customer lookup and the rejected invoice create for it.'
  },
  {
    caseId: 'fortnox.invoice.send-email',
    seeds: ['emailInvoiceDocumentNumber'],
    fileName: 'invoice-send-email.ts',
    exportName: 'fortnoxInvoiceSendEmailFixture',
    doc: 'Invoice email send answered with the invoice envelope.'
  }
]

export type RunOptions = {
  readonly live: boolean
  readonly help: boolean
  readonly record: boolean
  /** Synthetic, non-identifying account label. Required with `--live`. */
  readonly account: string | undefined
  readonly allowWrites: 'none' | 'reversible'
  /** Exact ids of write-irreversible cases a person explicitly started. */
  readonly allowIrreversible: ReadonlyArray<string>
  /** Raw seed identities from flags or environment (validated before a live run). */
  readonly seeds: Readonly<Partial<Record<FortnoxConformanceSeedKey, string>>>
}

export const defaultRunOptions: RunOptions = {
  live: false,
  help: false,
  record: false,
  account: undefined,
  allowWrites: 'none',
  allowIrreversible: [],
  seeds: {}
}

const irreversibleCaseIds = fortnoxConformanceCases
  .filter(testCase => testCase.safety === 'write-irreversible')
  .map(testCase => testCase.id)

const accountLabelPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example practice)'

export const accessTokenRequiredMessage = 'FORTNOX_ACCESS_TOKEN is required for --live'

const usage = `Usage: pnpm conformance:fortnox [--live --account <label>] [options]

Dry run by default: prints each case, its safety, and whether it would run. No network I/O.

Options:
  --live                          Run against the real Fortnox API (needs FORTNOX_ACCESS_TOKEN,
                                  --account, and the seeds of every case that will run)
  --account <label>               required with --live: synthetic, non-identifying label
                                  (lower-case letters, digits, hyphens; for example practice)
  --allow-writes <none|reversible>
                                  default none; reversible runs the write-reversible cases
  --allow-irreversible <case-id>  run this exact write-irreversible case (repeatable):
                                  ${irreversibleCaseIds.join(', ')}
  --record                        with --live: record, verify on replay, and rewrite the fixtures
                                  of the cases that passed
${fortnoxSeedSources
  .map(
    source =>
      `  ${`${source.flag} <value>`.padEnd(32)}${source.description}\n${' '.repeat(34)}(env ${source.env})`
  )
  .join('\n')}
  --help

FORTNOX_ACCESS_TOKEN is read from the environment only. Use a Fortnox developer test company,
never a real one. Review rewritten fixtures before committing.`

/**
 * Parse CLI arguments (without the node/script prefix) and seed environment variables. Throws on
 * unknown flags, missing values, invalid labels, unknown irreversible case ids, `--record`
 * without `--live`, and `--live` without `--account`.
 */
export const parseRunArgs = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = {}
): RunOptions => {
  let live = false
  let help = false
  let record = false
  let account: string | undefined
  let allowWrites: RunOptions['allowWrites'] = 'none'
  const allowIrreversible: Array<string> = []
  const seeds: Partial<Record<FortnoxConformanceSeedKey, string>> = {}

  for (const source of fortnoxSeedSources) {
    const value = env[source.env]?.trim()

    if (value !== undefined && value.length > 0) {
      seeds[source.key] = value
    }
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)

    const value = () => {
      const next = inline ?? argv[++index]

      if (next === undefined || next.length === 0) {
        throw new Error(`${flag} requires a value`)
      }

      return next
    }

    const seed = fortnoxSeedSources.find(source => source.flag === flag)

    if (seed !== undefined) {
      seeds[seed.key] = value()
      continue
    }

    switch (flag) {
      case '--live':
        live = true
        break
      case '--help':
      case '-h':
        help = true
        break
      case '--record':
        record = true
        break
      case '--account': {
        const label = value()

        if (!accountLabelPattern.test(label) || label.length > 40) {
          throw new Error(
            '--account must be a short synthetic label of lower-case letters, digits, and hyphens'
          )
        }

        account = label
        break
      }

      case '--allow-writes': {
        const mode = value()

        if (mode !== 'none' && mode !== 'reversible') {
          throw new Error('--allow-writes must be none or reversible')
        }

        allowWrites = mode
        break
      }

      case '--allow-irreversible': {
        const caseId = value()

        if (!irreversibleCaseIds.includes(caseId)) {
          throw new Error(
            `--allow-irreversible takes an exact write-irreversible case id: ${irreversibleCaseIds.join(', ')}`
          )
        }

        allowIrreversible.push(caseId)
        break
      }

      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (!help && record && !live) {
    throw new Error('--record requires --live')
  }

  if (!help && live && account === undefined) {
    throw new Error(liveAccountRequiredMessage)
  }

  return { live, help, record, account, allowWrites, allowIrreversible, seeds }
}

/** The live target the chosen flags describe (the dry run plans against the same target). */
export const liveTarget = (options: RunOptions): ConformanceTarget => ({
  kind: 'live',
  account: options.account ?? 'dry-run',
  allowWrites: options.allowWrites,
  allowIrreversible: options.allowIrreversible
})

const specFor = (caseId: string): FortnoxCaseSpec | undefined =>
  fortnoxCaseSpecs.find(spec => spec.caseId === caseId)

export type PlannedCase = {
  readonly id: string
  readonly safety: ConformanceSafety
  readonly skipReason: ConformanceSkipReason | undefined
  /** Seeds this case needs that the flags/environment do not supply. */
  readonly missingSeeds: ReadonlyArray<FortnoxConformanceSeedKey>
}

/** Pure plan: which cases run live under these flags, and which seeds they still need. */
export const planFortnoxRun = (options: RunOptions): ReadonlyArray<PlannedCase> =>
  fortnoxConformanceCases.map(testCase => ({
    id: testCase.id,
    safety: testCase.safety,
    skipReason: conformanceSkipReason(liveTarget(options), testCase),
    missingSeeds: (specFor(testCase.id)?.seeds ?? []).filter(
      key => options.seeds[key] === undefined
    )
  }))

const seedFlag = (key: FortnoxConformanceSeedKey): string =>
  fortnoxSeedSources.find(source => source.key === key)?.flag ?? key

export const dryRunReport = (options: RunOptions): string => {
  const planned = planFortnoxRun(options)

  const lines = planned.map(entry => {
    const status = entry.skipReason === undefined ? 'RUN ' : 'SKIP'
    const detail = entry.skipReason ?? ''

    const missing =
      entry.skipReason === undefined && entry.missingSeeds.length > 0
        ? `needs ${entry.missingSeeds.map(seedFlag).join(', ')}`
        : ''

    return [status, entry.id, `[${entry.safety}]`, detail, missing]
      .filter(part => part.length > 0)
      .join('  ')
  })

  return [
    'DRY RUN: no network request was made. Pass --live --account <label> to run (needs FORTNOX_ACCESS_TOKEN).',
    `Plan for a live target: allowWrites=${options.allowWrites}, allowIrreversible=[${options.allowIrreversible.join(', ')}]${options.record ? ', record' : ''}`,
    ...lines,
    'Use a Fortnox developer test company only. Write cases restore what they change.'
  ].join('\n')
}

export type LiveInputs = {
  readonly account: string
  readonly accessToken: string
  readonly seeds: FortnoxConformanceSeeds
}

const decodeSeeds = Schema.decodeUnknownOption(FortnoxConformanceSeeds)

/**
 * Everything a live run needs, or why it must refuse (before any network): a missing account
 * label or access token, missing seeds for cases that will run, or seeds that are not valid
 * Fortnox identifiers.
 */
export const liveInputs = (
  options: RunOptions,
  env: Readonly<Record<string, string | undefined>>
): { readonly refusal: string } | { readonly inputs: LiveInputs } => {
  if (options.account === undefined) {
    return { refusal: liveAccountRequiredMessage }
  }

  const accessToken = env.FORTNOX_ACCESS_TOKEN?.trim()

  if (accessToken === undefined || accessToken.length === 0) {
    return { refusal: accessTokenRequiredMessage }
  }

  const missing = planFortnoxRun(options)
    .filter(entry => entry.skipReason === undefined)
    .flatMap(entry => entry.missingSeeds)

  if (missing.length > 0) {
    const flags = [...new Set(missing)].map(seedFlag)

    return { refusal: `Missing seed identities for the cases that would run: ${flags.join(', ')}` }
  }

  const seeds = decodeSeeds(options.seeds)

  if (Option.isNone(seeds)) {
    return { refusal: 'Seed identities must be valid Fortnox document or customer numbers' }
  }

  return { inputs: { account: options.account, accessToken, seeds: seeds.value } }
}

class FortnoxRunFailed extends Schema.TaggedError<FortnoxRunFailed>()('FortnoxRunFailed', {
  message: Schema.String
}) {}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureDir = join(workspaceRoot, 'packages/connectors/src/fortnox/conformance')

const today = () => new Date().toISOString().slice(0, 10)

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: FortnoxConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(
      OAuthCredential.make({
        provider: 'fortnox',
        accessToken,
        expiresAt: Date.now() + 60 * 60 * 1000
      })
    ),
    Layer.succeed(FortnoxConformanceConfig, seeds)
  )

const quoted = (value: string): string =>
  /^[\w .:/-]*$/.test(value) ? `'${value}'` : JSON.stringify(value)

export const renderFixtureModule = (spec: FortnoxCaseSpec, fixture: WireFixture): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${spec.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ' * `pnpm conformance:fortnox --live --account <label> --record`.',
    ' */',
    `export const ${spec.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** The seeds module, in the exact committed format. */
export const renderSeedsModule = (seeds: FortnoxConformanceSeeds): string => {
  const entries = fortnoxSeedSources.flatMap(source => {
    const value = seeds[source.key]
    const schema = source.kind === 'document' ? 'FortnoxDocumentNumber' : 'FortnoxCustomerNumber'

    return value === undefined ? [] : [`  ${source.key}: ${schema}.make(${quoted(value)})`]
  })

  return [
    "import { FortnoxCustomerNumber, FortnoxDocumentNumber } from '../schemas.ts'",
    "import type { FortnoxConformanceSeeds } from './cases.ts'",
    '',
    '/**',
    ' * Seed identities the committed Fortnox fixtures were recorded with. Replaying the fixtures needs',
    ' * these exact seeds in `FortnoxConformanceConfig`. `pnpm conformance:fortnox --record` rewrites the',
    ' * seeds of every case it records.',
    ' */',
    'export const fortnoxConformanceFixtureSeeds: FortnoxConformanceSeeds = {',
    entries.join(',\n'),
    '}',
    ''
  ].join('\n')
}

/** Seeds for the committed fixtures after recording `recorded` with `live` seeds. */
export const mergedFixtureSeeds = (
  current: FortnoxConformanceSeeds,
  live: FortnoxConformanceSeeds,
  recorded: ReadonlyArray<string>
): FortnoxConformanceSeeds => {
  const keys = new Set(recorded.flatMap(caseId => specFor(caseId)?.seeds ?? []))
  const merged: MutableSeeds = { ...current }

  for (const key of keys) {
    copySeed(merged, live, key)
  }

  return merged
}

type MutableSeeds = { -readonly [K in FortnoxConformanceSeedKey]?: FortnoxConformanceSeeds[K] }

const copySeed = <K extends FortnoxConformanceSeedKey>(
  target: MutableSeeds,
  source: FortnoxConformanceSeeds,
  key: K
): void => {
  const value = source[key]

  if (value === undefined) {
    delete target[key]
  } else {
    target[key] = value
  }
}

type RecordedFixture = {
  readonly testCase: FortnoxConformanceCase
  readonly spec: FortnoxCaseSpec
  readonly fixture: WireFixture
}

/** Build a verified fixture for one passed case and prove it replays with the same case. */
const verifiedFixture = (
  testCase: FortnoxConformanceCase,
  recorder: WireRecorderApi,
  inputs: LiveInputs
) =>
  Effect.gen(function* () {
    const spec = specFor(testCase.id)

    if (spec === undefined) {
      return yield* new FortnoxRunFailed({ message: `No fixture module for ${testCase.id}` })
    }

    const exchanges = yield* recorder.drain

    const fixture = yield* makeWireFixture({
      id: `${testCase.id}.recorded`,
      caseId: testCase.id,
      evidence: 'verified',
      recordedAt: today(),
      account: inputs.account,
      endpoint: fortnoxApiBaseUrl,
      note: 'Recorded from a Fortnox developer test company by pnpm conformance:fortnox --live --record.',
      exchanges
    })

    const replayed = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      layer: () => casePorts(ReplayHttpClient.layer([fixture]), 'replay-access-token', inputs.seeds)
    })

    if (conformanceReportFailed(replayed)) {
      return yield* new FortnoxRunFailed({
        message: `${testCase.id} did not pass on replay of its recording; nothing was written`
      })
    }

    return { testCase, spec, fixture }
  }).pipe(
    Effect.mapError(error =>
      error instanceof FortnoxRunFailed
        ? error
        : new FortnoxRunFailed({
            message: `${testCase.id}: recording rejected (${error._tag}); nothing was written`
          })
    )
  )

const writeRecordings = (
  report: ConformanceReport,
  recorders: ReadonlyMap<string, WireRecorderApi>,
  inputs: LiveInputs
) =>
  Effect.gen(function* () {
    const passed = report.results.filter(result => result.status === 'passed')
    const recorded: Array<RecordedFixture> = []

    for (const result of passed) {
      const testCase = fortnoxConformanceCases.find(candidate => candidate.id === result.id)
      const recorder = recorders.get(result.id)

      if (testCase === undefined || recorder === undefined) {
        return yield* new FortnoxRunFailed({ message: `No recording for ${result.id}` })
      }

      recorded.push(yield* verifiedFixture(testCase, recorder, inputs))
    }

    if (recorded.length === 0) {
      console.log('No passed case to record.')

      return
    }

    // Everything verified: only now write the fixture modules and the seeds.
    const files = recorded.map(({ spec, fixture }) => {
      const file = join(fixtureDir, spec.fileName)

      writeFileSync(file, renderFixtureModule(spec, fixture))

      return file
    })

    const seedsFile = join(fixtureDir, 'seeds.ts')

    writeFileSync(
      seedsFile,
      renderSeedsModule(
        mergedFixtureSeeds(
          fortnoxConformanceFixtureSeeds,
          inputs.seeds,
          recorded.map(({ testCase }) => testCase.id)
        )
      )
    )

    execFileSync('pnpm', ['exec', 'oxfmt', '--write', ...files, seedsFile], {
      cwd: workspaceRoot,
      stdio: 'inherit'
    })

    console.log(
      `Wrote ${files.length} verified fixtures and updated seeds. Review them before committing: they contain practice-company data.`
    )
  })

const live = (options: RunOptions, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const checked = liveInputs(options, env)

    if ('refusal' in checked) {
      return yield* new FortnoxRunFailed({ message: checked.refusal })
    }

    const inputs = checked.inputs
    const recorders = yield* Ref.make(new Map<string, WireRecorderApi>())

    const httpFor = (testCase: FortnoxConformanceCase): Layer.Layer<HttpClient.HttpClient> =>
      options.record
        ? Layer.unwrap(
            Effect.gen(function* () {
              const upstream = yield* HttpClient.HttpClient
              const { client, recorder } = yield* makeRecordingHttpClient(upstream)

              yield* Ref.update(recorders, current => new Map(current).set(testCase.id, recorder))

              return Layer.succeed(HttpClient.HttpClient, client)
            })
          ).pipe(Layer.provide(FetchHttpClient.layer))
        : FetchHttpClient.layer

    const report = yield* runConformance(fortnoxConformanceCases, {
      target: liveTarget(options),
      layer: testCase => casePorts(httpFor(testCase), inputs.accessToken, inputs.seeds)
    })

    console.log(formatConformanceReport(report))

    if (options.record) {
      yield* writeRecordings(report, yield* Ref.get(recorders), inputs)
    }

    if (conformanceReportFailed(report)) {
      process.exitCode = 1
    }
  })

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

const parseCliArgs = (): RunOptions | undefined => {
  try {
    return parseRunArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1

    return undefined
  }
}

const runCli = (options: RunOptions): void => {
  if (options.help) {
    console.log(usage)
  } else if (!options.live) {
    console.log(dryRunReport(options))
  } else {
    Effect.runPromise(live(options, process.env)).catch(error => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
  }
}

if (invokedAsCli()) {
  const options = parseCliArgs()

  if (options !== undefined) {
    runCli(options)
  }
}
