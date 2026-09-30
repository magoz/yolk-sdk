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
 * and recorded in fixtures. Read cases always run; `--allow-writes reversible` adds the
 * write-reversible cases (the row and customer cases restore what they change; the rejection case
 * only writes if Fortnox wrongly accepts it, and then names the invoice to cancel by hand);
 * `--allow-irreversible <case-id>` (repeatable, exact ids) is the only way to run a
 * write-irreversible case such as sending an invoice email, which also needs `--email-recipient`
 * to equal the invoice's `EmailInformation.EmailAddressTo` exactly.
 *
 * `--record` (with `--live`) wraps the live client with the conformance `WireRecorder`. After the
 * run it builds `verified` fixtures (today's date, the account label) for the cases that passed,
 * re-runs each case on replay against its new fixture, and renders every fixture module plus the
 * seeds module. Only if every recorded case verified and passed the secret scan does it write them,
 * all or nothing, to a NEW run directory under the GITIGNORED root
 * `.conformance-recordings/fortnox/<YYYY-MM-DD>T<HHMMSS>Z-<random>/`: it writes the whole batch into
 * a sibling temp directory and publishes it with one rename, refuses an existing destination, and
 * leaves no run directory when anything fails. It never writes committed sources. It then prints a
 * review checklist (email-like strings outside `example.test`/`example.com`, names, `Comments`
 * values, and any PDF body).
 *
 * Promotion is manual: scrub the staged files of practice-company data, copy them into
 * `packages/connectors/src/fortnox/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/fortnox-conformance.test.ts` and
 * `scripts/test/run-fortnox-conformance.test.ts` in the same change: promoted fixtures change the
 * fixture ids (`.recorded`), `evidence` (`verified`), `account`, and the exchange indices and
 * bodies the drills rely on. A promoted payment-filter recording also needs the tests' fixed clock
 * (`atTestNow` in `packages/connectors/test/fortnox-conformance.test.ts`) moved past the recorded
 * overdue invoice's `DueDate`, or the case aborts with its overdue precondition.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import type { ConformanceSafety } from '../packages/conformance/src/case.ts'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireFixture
} from '../packages/conformance/src/fixture.ts'
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
  readonly kind: 'document' | 'customer' | 'email'
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
  },
  {
    key: 'emailRecipient',
    flag: '--email-recipient',
    env: 'FORTNOX_CONFORMANCE_EMAIL_RECIPIENT',
    kind: 'email',
    description:
      'address you control; must equal the email invoice EmailAddressTo exactly (no CC/BCC)'
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
    seeds: ['emailInvoiceDocumentNumber', 'emailRecipient'],
    fileName: 'invoice-send-email.ts',
    exportName: 'fortnoxInvoiceSendEmailFixture',
    doc: 'The invoice read that confirms the email recipient, then the email send answered with the invoice envelope.'
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
  --record                        with --live: record the cases that passed, verify on replay,
                                  and stage them in a new run directory under
                                  .conformance-recordings/fortnox/ (gitignored) for manual
                                  scrubbing and promotion
${fortnoxSeedSources
  .map(
    source =>
      `  ${`${source.flag} <value>`.padEnd(32)}${source.description}\n${' '.repeat(34)}(env ${source.env})`
  )
  .join('\n')}
  --help

FORTNOX_ACCESS_TOKEN is read from the environment only. Use a Fortnox developer test company,
never a real one. Recordings are never written over committed fixtures: scrub the staged files,
copy them into packages/connectors/src/fortnox/conformance/, and update the Fortnox conformance
tests in the same change (fixture ids, evidence, and account change).`

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
    'Use a Fortnox developer test company only. Row and customer write cases restore what they change; the rejection case writes only if Fortnox wrongly accepts it.'
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
    return {
      refusal:
        'Seed identities must be valid Fortnox document or customer numbers, and --email-recipient an email address'
    }
  }

  return { inputs: { account: options.account, accessToken, seeds: seeds.value } }
}

export class FortnoxRunFailed extends Schema.TaggedError<FortnoxRunFailed>()('FortnoxRunFailed', {
  message: Schema.String
}) {}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Gitignored root of staged recordings; one new directory per `--record` run. */
export const recordingsRoot = join(workspaceRoot, '.conformance-recordings', 'fortnox')

const committedSources = join(workspaceRoot, 'packages')

const isInside = (child: string, parent: string): boolean => {
  const path = relative(resolve(parent), resolve(child))

  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

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
  /^[\w .:/@+-]*$/.test(value) ? `'${value}'` : JSON.stringify(value)

export const renderFixtureModule = (spec: FortnoxCaseSpec, fixture: WireFixture): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${spec.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}), scrubbed and promoted by hand from`,
    ' * `pnpm conformance:fortnox --live --account <label> --record`.',
    ' */',
    `export const ${spec.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

/** The seeds module, in the exact committed format. */
export const renderSeedsModule = (seeds: FortnoxConformanceSeeds): string => {
  const entries = fortnoxSeedSources.flatMap(source => {
    const value = seeds[source.key]

    if (value === undefined) {
      return []
    }

    switch (source.kind) {
      case 'document':
        return [`  ${source.key}: FortnoxDocumentNumber.make(${quoted(value)})`]
      case 'customer':
        return [`  ${source.key}: FortnoxCustomerNumber.make(${quoted(value)})`]
      case 'email':
        return [`  ${source.key}: ${quoted(value)}`]
    }
  })

  return [
    "import { FortnoxCustomerNumber, FortnoxDocumentNumber } from '../schemas.ts'",
    "import type { FortnoxConformanceSeeds } from './cases.ts'",
    '',
    '/**',
    ' * Seed identities the committed Fortnox fixtures were recorded with. Replaying the fixtures needs',
    ' * these exact seeds in `FortnoxConformanceConfig`. `pnpm conformance:fortnox --record` stages an',
    ' * updated copy for manual promotion together with the fixtures it records.',
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
  inputs: LiveInputs,
  recordedAt: string
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
      recordedAt,
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

/**
 * Directory-level file side effects of `--record`; injectable so the staging gate is tested
 * offline without touching the filesystem.
 */
export type RecordingWriter = {
  readonly exists: (path: string) => boolean
  /** Create a directory and any missing parents. */
  readonly mkdir: (path: string) => void
  readonly writeFile: (path: string, contents: string) => void
  /** Rename a directory in one step (same filesystem). */
  readonly rename: (from: string, to: string) => void
  /** Remove a directory and everything in it. */
  readonly rm: (path: string) => void
}

export const nodeRecordingWriter: RecordingWriter = {
  exists: path => existsSync(path),
  mkdir: path => {
    mkdirSync(path, { recursive: true })
  },
  writeFile: (path, contents) => {
    writeFileSync(path, contents, { flag: 'wx' })
  },
  rename: (from, to) => {
    renameSync(from, to)
  },
  rm: path => {
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * A unique run directory name, `<YYYY-MM-DD>T<HHMMSS>Z-<suffix>` (UTC), so two recordings on the
 * same day never share a directory.
 */
export const recordingRunId = (now: Date, suffix: string): string => {
  const iso = now.toISOString()

  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(':', '')}Z-${suffix}`
}

const randomRunSuffix = (): string => randomBytes(4).toString('hex')

export type StageRecordingsOptions = {
  readonly writer: RecordingWriter
  /** The gitignored recordings root (defaults to `recordingsRoot`). */
  readonly recordingsRoot?: string
  /**
   * The run directory to publish; must be a new, direct child of the recordings root (for example
   * `join(recordingsRoot, recordingRunId(now, suffix))`).
   */
  readonly stagingDir: string
  /** `recordedAt` of the staged fixtures (`YYYY-MM-DD`). */
  readonly recordedAt: string
}

export type StagedRecordings = {
  readonly stagingDir: string
  readonly files: ReadonlyArray<string>
  readonly checklist: ReadonlyArray<string>
}

/** Email-address domains the committed fixtures may contain. */
const allowedEmailDomains = ['example.test', 'example.com']

const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const isAllowedEmail = (email: string): boolean => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()

  return allowedEmailDomains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`))
}

/** Keys whose string values usually name a person or company. */
const isNameKey = (key: string): boolean => /Name$|^(?:Our|Your)Reference$/.test(key)

type ReviewFindings = {
  readonly emails: Set<string>
  readonly names: Set<string>
  readonly comments: Set<string>
}

const collectStrings = (value: unknown, key: string | undefined, found: ReviewFindings): void => {
  if (Predicate.isString(value)) {
    for (const email of value.match(emailPattern) ?? []) {
      if (!isAllowedEmail(email)) {
        found.emails.add(email)
      }
    }

    if (key !== undefined && value.trim().length > 0) {
      if (key === 'Comments') found.comments.add(value)
      else if (isNameKey(key)) found.names.add(value)
    }

    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, key, found)

    return
  }

  if (Predicate.isObject(value)) {
    for (const [childKey, child] of Object.entries(value)) collectStrings(child, childKey, found)
  }
}

/** A text body as JSON when it parses, otherwise the raw text (still scanned for emails). */
const parsedText = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const quotedList = (values: ReadonlySet<string>): string =>
  [...values].map(value => JSON.stringify(value)).join(', ')

/**
 * What a person must check in each staged fixture before promoting it: email-like strings outside
 * `example.test`/`example.com`, names, `Comments` values, and binary (PDF) bodies. The script only
 * lists candidates; it does not decide what is personal data.
 */
export const recordingReviewChecklist = (
  recorded: ReadonlyArray<{ readonly spec: FortnoxCaseSpec; readonly fixture: WireFixture }>
): ReadonlyArray<string> => {
  const lines = [
    'REVIEW before promoting (staged files hold practice-company data):',
    '  also check addresses, phone numbers, organisation numbers, and free-text fields by hand'
  ]

  for (const { spec, fixture } of recorded) {
    const found: ReviewFindings = { emails: new Set(), names: new Set(), comments: new Set() }
    let binaryBodies = 0

    for (const exchange of fixture.exchanges) {
      collectStrings(exchange.request.url, undefined, found)
      collectStrings(exchange.request.body, undefined, found)

      const { response } = exchange

      if (isWireBase64BodyResponse(response)) {
        binaryBodies += 1
      } else if (isWireStreamResponse(response)) {
        const text = response.chunks.map(chunk => (Predicate.isString(chunk) ? chunk : '')).join('')

        binaryBodies += response.chunks.some(chunk => !Predicate.isString(chunk)) ? 1 : 0
        collectStrings(parsedText(text), undefined, found)
      } else {
        collectStrings(parsedText(response.body), undefined, found)
      }
    }

    const items = [
      found.emails.size > 0
        ? `emails outside ${allowedEmailDomains.join('/')}: ${quotedList(found.emails)}`
        : undefined,
      found.names.size > 0 ? `names: ${quotedList(found.names)}` : undefined,
      found.comments.size > 0 ? `Comments values: ${quotedList(found.comments)}` : undefined,
      binaryBodies > 0
        ? `${binaryBodies} binary body (PDF): open it and check the rendered document`
        : undefined
    ].filter((item): item is string => item !== undefined)

    lines.push(
      `  ${spec.fileName}: ${items.length === 0 ? 'no candidates found; still read it' : ''}`.trimEnd(),
      ...items.map(item => `    - ${item}`)
    )
  }

  lines.push(
    'PROMOTE by hand: scrub, copy into packages/connectors/src/fortnox/conformance/, run pnpm format:fix,',
    '  and update the Fortnox conformance tests in the same change (fixture ids, evidence, account change).'
  )

  return lines
}

/**
 * The `--record` gate. Verifies every passed case's recording on replay (and the secret scan), then
 * renders every fixture module and the seeds module, writes them all into a sibling temp directory
 * (`<root>/.tmp-<run>`), and publishes that directory to `options.stagingDir` with one rename.
 * All or nothing: any failure (verification, a write, or the rename) leaves no staging directory,
 * and the temp directory is removed (best effort). A staging directory that is not a direct child
 * of the recordings root, or that already exists, is refused. Returns `undefined` when no case
 * passed.
 */
export const stageRecordings = (
  report: ConformanceReport,
  recorders: ReadonlyMap<string, WireRecorderApi>,
  inputs: LiveInputs,
  options: StageRecordingsOptions
) =>
  Effect.gen(function* () {
    const root = resolve(options.recordingsRoot ?? recordingsRoot)
    const stagingDir = resolve(options.stagingDir)
    const runName = basename(stagingDir)

    if (isInside(root, committedSources)) {
      return yield* new FortnoxRunFailed({
        message: `Refusing a recordings root inside committed package sources (${root}); nothing was written`
      })
    }

    if (dirname(stagingDir) !== root || runName.startsWith('.')) {
      return yield* new FortnoxRunFailed({
        message: `Refusing to stage recordings outside the recordings root (${root}); nothing was written`
      })
    }

    const { writer } = options
    const tempDir = join(root, `.tmp-${runName}`)

    const refuseExisting = Effect.suspend(() =>
      writer.exists(stagingDir) || writer.exists(tempDir)
        ? Effect.fail(
            new FortnoxRunFailed({
              message: `Refusing to overwrite ${stagingDir}; nothing was written`
            })
          )
        : Effect.void
    )

    yield* refuseExisting

    const passed = report.results.filter(result => result.status === 'passed')
    const recorded: Array<RecordedFixture> = []

    for (const result of passed) {
      const testCase = fortnoxConformanceCases.find(candidate => candidate.id === result.id)
      const recorder = recorders.get(result.id)

      if (testCase === undefined || recorder === undefined) {
        return yield* new FortnoxRunFailed({ message: `No recording for ${result.id}` })
      }

      recorded.push(yield* verifiedFixture(testCase, recorder, inputs, options.recordedAt))
    }

    if (recorded.length === 0) {
      return undefined
    }

    // Everything verified: render every file before writing any of them.
    const files = [
      ...recorded.map(({ spec, fixture }) => ({
        name: spec.fileName,
        contents: renderFixtureModule(spec, fixture)
      })),
      {
        name: 'seeds.ts',
        contents: renderSeedsModule(
          mergedFixtureSeeds(
            fortnoxConformanceFixtureSeeds,
            inputs.seeds,
            recorded.map(({ testCase }) => testCase.id)
          )
        )
      }
    ]

    yield* refuseExisting

    yield* Effect.try({
      try: () => {
        writer.mkdir(tempDir)

        for (const file of files) {
          writer.writeFile(join(tempDir, file.name), file.contents)
        }

        // Publish the complete batch in one step, only after every file is written.
        writer.rename(tempDir, stagingDir)
      },
      catch: () => {
        try {
          writer.rm(tempDir)
        } catch {
          // Best effort: the temp directory is gitignored and never read as a staged run.
        }

        return new FortnoxRunFailed({
          message: `Writing the staged recordings failed; nothing was staged in ${stagingDir}`
        })
      }
    })

    return {
      stagingDir,
      files: files.map(file => join(stagingDir, file.name)),
      checklist: recordingReviewChecklist(recorded)
    }
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
      const now = new Date()

      const staged = yield* stageRecordings(report, yield* Ref.get(recorders), inputs, {
        writer: nodeRecordingWriter,
        stagingDir: join(recordingsRoot, recordingRunId(now, randomRunSuffix())),
        recordedAt: now.toISOString().slice(0, 10)
      })

      if (staged === undefined) {
        console.log('No passed case to record.')
      } else {
        console.log(
          [
            `Staged ${staged.files.length} files (gitignored) in ${relative(workspaceRoot, staged.stagingDir)}; nothing committed was changed.`,
            ...staged.checklist
          ].join('\n')
        )
      }
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
