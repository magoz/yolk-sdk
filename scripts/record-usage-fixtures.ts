/**
 * Subscription-usage wire-fixture probe for Claude, Codex, and Grok, one family per run:
 * `pnpm conformance:usage --family claude|codex|grok`. (OpenCode Go usage is recorded with the
 * other Go cases by `pnpm conformance:opencode`, which reads `OPENCODE_API_KEY`.)
 *
 * The family's usage conformance case (`anthropicClaudeUsageSnapshotCase`,
 * `openAiCodexUsageSnapshotCase`, `xAiGrokUsageSnapshotCase`) is the single source of truth: this
 * script defines no requests of its own.
 *
 * Default: DRY RUN. Prints the case, its endpoint, and the fixture module it would write, and
 * exits without any network call or credential read.
 *
 * `--live`: the credentials are consumer subscription OAuth access tokens, so a live run reads the
 * owner's private subscription endpoints and must follow the provider's terms. **Live runs need
 * the repository owner's explicit approval**, confirmed with `--owner-approved`; never run them in
 * CI (`--live` is refused whenever the `CI` environment variable is set to any non-empty value,
 * `0` and `false` included). A live run also needs an explicit `--account <label>` (synthetic,
 * non-identifying, committed in public fixtures) and the family's credentials:
 *
 * - claude: `ANTHROPIC_CLAUDE_ACCESS_TOKEN` (a Claude OAuth access token);
 * - codex: `OPENAI_CODEX_ACCESS_TOKEN` and `OPENAI_CODEX_ACCOUNT_ID` (sent as
 *   `ChatGPT-Account-Id`, never recorded);
 * - grok: `XAI_GROK_ACCESS_TOKEN`, `XAI_GROK_USER_ID` (the authenticated xAI user id, sent as
 *   `x-userid`, never recorded), and `--client-version <v>` (the truthful host client version;
 *   never impersonate an official Grok version).
 *
 * The case runs with `runConformance` on a live target through the conformance recorder around a
 * real fetch `HttpClient` (request headers `content-type` and `accept` only, response headers
 * `content-type` only). Account identifiers a usage body may carry (`usageRedaction`) are
 * redacted value by value; a non-string value, a repeated redacted key, or a body the member
 * scanner cannot fully scan refuses the write. The single recorded exchange becomes a `verified`
 * fixture dated today, replays through the same case, and is written only if everything passes.
 */
import { join } from 'node:path'
import process from 'node:process'
import { Data, Effect, Layer } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  AnthropicClaudeUsageConformanceConfig,
  anthropicClaudeUsageConformanceUrl,
  anthropicClaudeUsageSnapshotCase
} from '@yolk-sdk/agent/providers/anthropic/conformance'
import {
  OpenAiCodexUsageConformanceConfig,
  openAiCodexUsageConformanceUrl,
  openAiCodexUsageSnapshotCase
} from '@yolk-sdk/agent/providers/openai/conformance'
import {
  XAiGrokUsageConformanceConfig,
  xAiGrokUsageConformanceUrl,
  xAiGrokUsageSnapshotCase
} from '@yolk-sdk/agent/providers/xai/conformance'
import type { WireFixture } from '../packages/conformance/src/fixture.ts'
import { makeWireFixture, WireRecorder } from '../packages/conformance/src/record.ts'
import { ReplayHttpClient } from '../packages/conformance/src/replay.ts'
import {
  conformanceReportFailed,
  conformanceSkipReason,
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceTarget
} from '../packages/conformance/src/runner.ts'
import {
  accountIdentifierFields,
  defaultFixtureWriter,
  invokedAsCli,
  isCiEnvironment,
  parseFlags,
  redactExchange,
  redactionRefusal,
  today,
  workspaceRoot,
  type FixtureWriter,
  type ProbeEnv,
  type RedactionSpec
} from './fixture-probe-internal.ts'

export type UsageFamily = 'claude' | 'codex' | 'grok'

export type ProbeOptions = {
  readonly family: UsageFamily | undefined
  readonly live: boolean
  readonly help: boolean
  /** Explicit confirmation that the repository owner approved this live run. */
  readonly ownerApproved: boolean
  /** Grok only: the truthful host client version. Required with `--live --family grok`. */
  readonly clientVersion: string | undefined
  /** Synthetic, non-identifying fixture account label. Required with `--live`. */
  readonly account: string | undefined
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  family: undefined,
  live: false,
  help: false,
  ownerApproved: false,
  clientVersion: undefined,
  account: undefined
}

/** One family's case, endpoint, credential variables, and fixture module. */
export type UsageFamilySpec = {
  readonly family: UsageFamily
  readonly label: string
  readonly caseId: string
  readonly endpoint: string
  readonly tokenEnv: string
  readonly tokenProvider: string
  /** Required account variable (Codex account id, Grok user id); never recorded. */
  readonly accountEnv: string | undefined
  readonly regenerateCommand: string
  readonly fixtureDir: string
  readonly fileName: string
  readonly exportName: string
  readonly doc: string
}

export const usageFamilies: Readonly<Record<UsageFamily, UsageFamilySpec>> = {
  claude: {
    family: 'claude',
    label: 'the Claude OAuth usage endpoint',
    caseId: anthropicClaudeUsageSnapshotCase.id,
    endpoint: anthropicClaudeUsageConformanceUrl,
    tokenEnv: 'ANTHROPIC_CLAUDE_ACCESS_TOKEN',
    tokenProvider: 'anthropic-claude',
    accountEnv: undefined,
    regenerateCommand:
      'pnpm conformance:usage --family claude --live --owner-approved --account <label>',
    fixtureDir: join(workspaceRoot, 'packages/agent/src/providers/anthropic/conformance'),
    fileName: 'claude-usage-snapshot.ts',
    exportName: 'anthropicClaudeUsageSnapshotFixture',
    doc: 'Claude subscription-usage snapshot: `GET /api/oauth/usage` answering `five_hour` and `seven_day` windows as `{ utilization, resets_at }`.'
  },
  codex: {
    family: 'codex',
    label: 'the ChatGPT usage endpoint',
    caseId: openAiCodexUsageSnapshotCase.id,
    endpoint: openAiCodexUsageConformanceUrl,
    tokenEnv: 'OPENAI_CODEX_ACCESS_TOKEN',
    tokenProvider: 'openai-codex',
    accountEnv: 'OPENAI_CODEX_ACCOUNT_ID',
    regenerateCommand:
      'pnpm conformance:usage --family codex --live --owner-approved --account <label>',
    fixtureDir: join(workspaceRoot, 'packages/agent/src/providers/openai/conformance'),
    fileName: 'codex-usage-snapshot.ts',
    exportName: 'openAiCodexUsageSnapshotFixture',
    doc: 'Codex subscription-usage snapshot: `GET /backend-api/wham/usage` answering `rate_limit` with `primary_window` and `secondary_window`.'
  },
  grok: {
    family: 'grok',
    label: 'the Grok CLI proxy billing endpoint',
    caseId: xAiGrokUsageSnapshotCase.id,
    endpoint: xAiGrokUsageConformanceUrl,
    tokenEnv: 'XAI_GROK_ACCESS_TOKEN',
    tokenProvider: 'xai-grok',
    accountEnv: 'XAI_GROK_USER_ID',
    regenerateCommand:
      'pnpm conformance:usage --family grok --live --owner-approved --account <label> --client-version <version>',
    fixtureDir: join(workspaceRoot, 'packages/agent/src/providers/xai/conformance'),
    fileName: 'usage-snapshot.ts',
    exportName: 'xAiGrokUsageSnapshotFixture',
    doc: 'Grok subscription-usage snapshot: `GET /v1/billing?format=credits` on the CLI proxy answering `config.creditUsagePercent` and `config.currentPeriod`.'
  }
}

/** Account identifiers a usage body may carry; none is read by the parsers. */
export const usageRedaction: RedactionSpec = {
  fields: accountIdentifierFields,
  placeholder: 'redacted',
  permittedNonJson: []
}

const usage = `Usage: pnpm conformance:usage --family claude|codex|grok [--live --owner-approved --account <label>] [options]

Dry run by default: lists the family's usage conformance case and performs no network I/O and no
credential read. --live runs the case against the real endpoint through the wire recorder, replays
the new fixture through the same case, and writes the fixture module only if it passes.

The credentials are consumer subscription OAuth access tokens: live runs need the repository
owner's explicit approval (--owner-approved). Never run them in CI: --live is refused whenever the
CI environment variable is set to any non-empty value (0 and false included).

Options:
  --family claude|codex|grok   required
  --live                       record against the real endpoint (needs --owner-approved,
                               --account, and the family's credentials)
  --owner-approved             confirm the repository owner approved this live run
  --account <label>            required with --live: synthetic, non-identifying account label
  --client-version <v>         grok only, required with --live: truthful host client version
  --help

Credentials:
  claude: ${usageFamilies.claude.tokenEnv}
  codex:  ${usageFamilies.codex.tokenEnv} and ${usageFamilies.codex.accountEnv ?? ''}
  grok:   ${usageFamilies.grok.tokenEnv} and ${usageFamilies.grok.accountEnv ?? ''}

Review the rewritten fixture before committing: it must contain synthetic content only.`

export const familyRequiredMessage = '--family claude|codex|grok is required'

export const liveAccountRequiredMessage =
  '--live requires --account <label>: a synthetic, non-identifying label (for example synthetic) that is committed in public fixtures'

export const ownerApprovalRequiredMessage =
  "--live requires --owner-approved: live runs use a subscription OAuth credential and need the repository owner's explicit approval"

export const liveInCiMessage =
  "--live is refused in CI (the CI environment variable is set to a non-empty value): live runs use a subscription OAuth credential and must be run by hand with the repository owner's approval"

export const clientVersionRequiredMessage =
  '--live --family grok requires --client-version <v>: the truthful host client version sent as x-grok-client-version'

const parseFamily = (family: string): UsageFamily => {
  if (family !== 'claude' && family !== 'codex' && family !== 'grok') {
    throw new Error(`Unknown family: ${family} (expected claude, codex, or grok)`)
  }

  return family
}

/**
 * Parse CLI arguments (without the node/script prefix). Throws on unknown flags, a missing or
 * unknown family, on `--live` in CI (`env.CI` set), and on `--live` without `--owner-approved`,
 * `--account`, or (Grok) `--client-version`.
 */
export const parseProbeArgs = (argv: ReadonlyArray<string>, env: ProbeEnv = {}): ProbeOptions => {
  const options: MutableProbeOptions = { ...defaultProbeOptions }

  parseFlags(argv, (flag, argument, value) => {
    switch (flag) {
      case '--family':
        options.family = parseFamily(value())
        break
      case '--live':
        options.live = true
        break
      case '--owner-approved':
        options.ownerApproved = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      case '--client-version':
        options.clientVersion = value()
        break
      case '--account':
        options.account = value()
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  })

  if (options.help) return options

  if (options.family === undefined) throw new Error(familyRequiredMessage)

  if (options.live && isCiEnvironment(env)) throw new Error(liveInCiMessage)

  if (options.live && !options.ownerApproved) throw new Error(ownerApprovalRequiredMessage)

  if (options.live && options.account === undefined) throw new Error(liveAccountRequiredMessage)

  if (options.live && options.family === 'grok' && options.clientVersion === undefined) {
    throw new Error(clientVersionRequiredMessage)
  }

  return options
}

/** The family a run targets; throws without one (parsed options always carry it). */
export const familySpecOf = (options: ProbeOptions): UsageFamilySpec => {
  if (options.family === undefined) throw new Error(familyRequiredMessage)

  return usageFamilies[options.family]
}

export const dryRunReport = (options: ProbeOptions): string => {
  const spec = familySpecOf(options)

  const credentials =
    spec.accountEnv === undefined ? spec.tokenEnv : `${spec.tokenEnv} and ${spec.accountEnv}`

  return [
    `DRY RUN: no network request was made and no credential was read. Pass --live --owner-approved --account <label> to record (needs ${credentials}${spec.family === 'grok' ? ' and --client-version' : ''}).`,
    `Endpoint: GET ${spec.endpoint} (${spec.label}; subscription OAuth bearer)`,
    "Live runs use the owner's subscription OAuth credential and need the repository owner's explicit approval; never run them in CI.",
    'Conformance cases:',
    `- ${spec.caseId} [read]  -> ${spec.fileName}`,
    'With --live, the case runs against the endpoint through the wire recorder, then the new',
    'fixture is verified by running the same case on replay; nothing is written unless it passes.'
  ].join('\n')
}

/** The credentials a run sends (read from the environment only with `--live`). */
export type UsageCredential = {
  readonly accessToken: string
  /** Codex account id or Grok user id. */
  readonly account?: string | undefined
}

/** Client version the replay verification sends (replay matches method and URL only). */
export const replayClientVersion = '0.0.0-conformance-replay'

/** Run the family's usage case with the given credential and HttpClient. */
export const runUsageCase = (
  options: ProbeOptions,
  credential: UsageCredential,
  run: {
    readonly target: ConformanceTarget
    readonly fixtures?: ReadonlyArray<WireFixture>
    readonly fixtureIds?: ReadonlyArray<string>
    readonly httpLayer: Layer.Layer<HttpClient.HttpClient>
  }
): Effect.Effect<ConformanceReport> => {
  const spec = familySpecOf(options)

  const token = new OAuthAccessToken({
    provider: spec.tokenProvider,
    accessToken: credential.accessToken,
    // The issuer owns the real expiry; this only satisfies local checks.
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: spec.family === 'codex' ? credential.account : undefined
  })

  const settings =
    run.fixtures === undefined
      ? { target: run.target }
      : { target: run.target, fixtures: run.fixtures }

  const withFixtures = <C extends { readonly fixtures: ReadonlyArray<string> }>(testCase: C): C =>
    run.fixtureIds === undefined ? testCase : { ...testCase, fixtures: run.fixtureIds }

  switch (spec.family) {
    case 'claude':
      return runConformance([withFixtures(anthropicClaudeUsageSnapshotCase)], {
        ...settings,
        layer: () =>
          Layer.mergeAll(
            run.httpLayer,
            Layer.succeed(AnthropicClaudeUsageConformanceConfig, { token })
          )
      })
    case 'codex':
      return runConformance([withFixtures(openAiCodexUsageSnapshotCase)], {
        ...settings,
        layer: () =>
          Layer.mergeAll(run.httpLayer, Layer.succeed(OpenAiCodexUsageConformanceConfig, { token }))
      })
    case 'grok':
      return runConformance([withFixtures(xAiGrokUsageSnapshotCase)], {
        ...settings,
        layer: () =>
          Layer.mergeAll(
            run.httpLayer,
            Layer.succeed(XAiGrokUsageConformanceConfig, {
              token,
              xAiUserId: credential.account ?? 'synthetic-replay-user',
              clientVersion: options.clientVersion ?? replayClientVersion
            })
          )
      })
  }
}

/** Run the family's case on replay against `fixtures` with synthetic credentials. */
export const verifyUsageFixtures = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ProbeOptions
): Effect.Effect<ConformanceReport> =>
  runUsageCase(
    options,
    { accessToken: 'synthetic-replay-token', account: 'synthetic-replay-account' },
    {
      target: { kind: 'replay' },
      fixtures,
      fixtureIds: fixtures.map(fixture => fixture.id),
      httpLayer: ReplayHttpClient.layer(fixtures)
    }
  )

export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly caseId: string
  readonly message: string
}> {}

const recordCase = (options: ProbeOptions, credential: UsageCredential, account: string) =>
  Effect.gen(function* () {
    const spec = familySpecOf(options)
    const caseId = spec.caseId
    const recorder = yield* WireRecorder
    const client = yield* HttpClient.HttpClient

    const report = yield* runUsageCase(options, credential, {
      target: { kind: 'live', account },
      httpLayer: Layer.succeed(HttpClient.HttpClient, client)
    })

    if (report.summary.passed !== 1) {
      const [line] = formatConformanceReport(report).split('\n')

      return yield* new ProbeFailed({ caseId, message: `conformance case failed live: ${line}` })
    }

    const exchanges = yield* recorder.drain.pipe(
      Effect.mapError(error => new ProbeFailed({ caseId, message: error.message }))
    )

    if (exchanges.length !== 1) {
      return yield* new ProbeFailed({
        caseId,
        message: `expected exactly one exchange, recorded ${exchanges.length}`
      })
    }

    const redacted = exchanges.map(exchange => redactExchange(exchange, usageRedaction))
    const refusal = redactionRefusal(redacted, usageRedaction)

    if (refusal !== undefined) return yield* new ProbeFailed({ caseId, message: refusal })

    return yield* makeWireFixture({
      id: `${caseId}.recorded`,
      caseId,
      evidence: 'verified',
      recordedAt: today(),
      account,
      endpoint: spec.endpoint,
      note: `Recorded from ${spec.label} by running its conformance case through pnpm conformance:usage --family ${spec.family} --live. Account identifiers are redacted.`,
      exchanges: redacted
    }).pipe(Effect.mapError(error => new ProbeFailed({ caseId, message: error.message })))
  }).pipe(
    Effect.provide(
      WireRecorder.layer({ responseHeaders: ['content-type'] }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    )
  )

export const renderFixtureModule = (options: ProbeOptions, fixture: WireFixture): string => {
  const spec = familySpecOf(options)

  return [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${spec.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ` * \`${spec.regenerateCommand}\`.`,
    ' */',
    `export const ${spec.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')
}

/**
 * The write gate: refuse a recording that still carries a redacted field or a payload the
 * survivor check cannot scan, then replay it through the case and write the fixture module only
 * when the report passes. Exactly one fixture for the family's case is required. On failure
 * nothing is written.
 */
export const writeVerifiedFixture = (
  fixture: WireFixture,
  options: ProbeOptions,
  writer: FixtureWriter = defaultFixtureWriter
) =>
  Effect.gen(function* () {
    const spec = familySpecOf(options)

    if (fixture.caseId !== spec.caseId) {
      return yield* new ProbeFailed({
        caseId: fixture.caseId,
        message: `the recording is not for ${spec.caseId}; no fixture was written`
      })
    }

    const refusal = redactionRefusal(fixture.exchanges, usageRedaction)

    if (refusal !== undefined) {
      return yield* new ProbeFailed({
        caseId: fixture.caseId,
        message: `${refusal}; no fixture was written`
      })
    }

    const report = yield* verifyUsageFixtures([fixture], options)

    if (conformanceReportFailed(report)) {
      yield* Effect.sync(() => console.error(formatConformanceReport(report)))

      return yield* new ProbeFailed({
        caseId: fixture.caseId,
        message: 'the recorded fixture failed replay verification; no fixture was written'
      })
    }

    const file = join(spec.fixtureDir, spec.fileName)

    yield* Effect.sync(() => {
      writer.writeFile(file, renderFixtureModule(options, fixture))
      writer.formatFiles([file])
    })

    return { report, files: [file] }
  })

const live = (options: ProbeOptions, writer: FixtureWriter = defaultFixtureWriter) =>
  Effect.gen(function* () {
    const spec = familySpecOf(options)
    const account = options.account

    if (isCiEnvironment(process.env)) {
      return yield* new ProbeFailed({ caseId: '*', message: liveInCiMessage })
    }

    if (!options.ownerApproved) {
      return yield* new ProbeFailed({ caseId: '*', message: ownerApprovalRequiredMessage })
    }

    if (account === undefined) {
      return yield* new ProbeFailed({ caseId: '*', message: liveAccountRequiredMessage })
    }

    const skipReason = conformanceSkipReason(
      { kind: 'live', account },
      { id: spec.caseId, safety: 'read' }
    )

    if (skipReason !== undefined) {
      return yield* new ProbeFailed({ caseId: spec.caseId, message: skipReason })
    }

    const required = [spec.tokenEnv, ...(spec.accountEnv === undefined ? [] : [spec.accountEnv])]
    const missing = required.filter(name => (process.env[name] ?? '').trim().length === 0)

    if (missing.length > 0) {
      return yield* new ProbeFailed({
        caseId: '*',
        message: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required for --live`
      })
    }

    const credential: UsageCredential = {
      accessToken: process.env[spec.tokenEnv] ?? '',
      account: spec.accountEnv === undefined ? undefined : process.env[spec.accountEnv]
    }

    const fixture = yield* recordCase(options, credential, account)
    const { report, files } = yield* writeVerifiedFixture(fixture, options, writer)

    console.log(formatConformanceReport(report))
    console.log(`Wrote ${files.length} verified fixture. Review it before committing.`)
  })

const runCli = (): void => {
  let options: ProbeOptions

  try {
    options = parseProbeArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1

    return
  }

  if (options.help) {
    console.log(usage)
  } else if (!options.live) {
    console.log(dryRunReport(options))
  } else {
    Effect.runPromise(live(options)).catch(error => {
      const scope = error instanceof ProbeFailed && error.caseId !== '*' ? `${error.caseId}: ` : ''

      console.error(`${scope}${error instanceof Error ? error.message : error}`)
      process.exitCode = 1
    })
  }
}

if (invokedAsCli(import.meta.url, process.argv[1])) runCli()
