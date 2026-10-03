/**
 * MCP conformance runner for a provider target (`pnpm conformance:mcp --target afloat`).
 *
 * Runs the generic cases of `@yolk-sdk/mcp/conformance` through the real `@yolk-sdk/mcp/client`
 * against one provider target. `--target` is required: `afloat` is the only target; `figma` is
 * refused (blocked until an owner-approved practice seat exists).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags (the era filter lists `mcp.legacy.session` as not applicable: Afloat is modern), then exits
 * without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real
 * `https://useafloat.com/mcp` with a `FetchHttpClient` (https only). Refused whenever `CI` is
 * non-empty and without `--owner-approved`. Requires `AFLOAT_API_KEY` (environment only, never a
 * flag; a practice account's key, refused before any request unless it is `afloat_` followed by 16
 * to 256 letters and digits; never printed). The target comes from running the REAL
 * `afloat.mcp_auth` action over a static credential resolver, so the key travels exactly as hosts
 * send it (`Authorization: Bearer <key>`); the auth case sends the public reserved invalid key
 * `afloat_yolkconformanceinvalid0000` instead. Every case is a read. The listing cases and the
 * absent-tool calls (gated by the observer: forwarded only when the call's own listing proves the
 * tool absent) always run; a live run calls a real tool ONLY when a person names it:
 * `--read-tool <name> --read-args <json>` adds `mcp.tools.call-read`, and
 * `--read-tool <name> --invalid-args <json>` adds `mcp.tools.call-tool-error`. These are flags
 * only: no environment variable can switch a tool call on. The listing must mark that tool
 * `readOnlyHint: true` (checked before the call and again by the call gate). Even a read can mint
 * state at Afloat (its download-grant tools issue a one-hour grant), so prefer a plain read such as
 * `list-invoices` with `{"size":10}`.
 *
 * `--record` stages verified recordings all or nothing in a new run directory under the gitignored
 * `.conformance-recordings/mcp/afloat/`, never over committed fixtures; the live key is never
 * recorded (`authorization` is always dropped) and a recording carrying it, or its secret remainder
 * after `afloat_` alone (`tokenSecretParts`), in any encoding is refused; every printed line is
 * redacted of both. Argument errors never repeat an argument's value. Recordings hold
 * practice-account data and this repository is public, so promotion replaces every `tools/call`
 * answer body wholesale with a minimal synthetic body (and the seeded arguments with synthetic
 * ones), keeps the published tool subset of the listing only, copies the result into
 * `packages/connectors/src/afloat/conformance/`, runs `pnpm format:fix`, and updates
 * `packages/connectors/test/afloat-mcp-conformance.test.ts`, this runner's test, and the emulator's
 * Afloat copy (`packages/emulators/src/mcp/afloat-recordings.ts`) in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import {
  afloatMcpConformanceFixtureSeeds,
  afloatMcpConformanceLiveSeeds,
  afloatMcpConformanceNotApplicable,
  makeAfloatMcpConformanceTarget
} from '../packages/connectors/src/afloat/conformance/index.ts'
import { afloatMcpServerUrl } from '../packages/connectors/src/afloat/index.ts'
import { staticCredentialResolverLayer } from '../packages/connectors/src/conformance/index.ts'
import { ApiKeyCredential } from '../packages/connectors/src/credential.ts'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceCases,
  selectMcpConformanceCases,
  type McpConformanceError,
  type McpConformanceRequirements,
  type McpConformanceSeeds
} from '../packages/mcp/src/conformance/index.ts'
import {
  dryRunReport,
  interruptOptionsFor,
  leftoverWarnings,
  liveInputs,
  parseRunArgs,
  processCliIo,
  processSignals,
  redactingCliIo,
  runnerLiveSecrets,
  runInterruptibly,
  runLive,
  usage,
  type CaseSpec,
  type CliIo,
  type ConnectorConformanceRunner,
  type LiveInputs,
  type RunOptions,
  type SeedSource
} from './connector-conformance-internal.ts'
import type { ProbeEnv } from './fixture-probe-internal.ts'

/** The seeds a person names for the calling cases (flags only, never the environment). */
export type McpSeedKey = 'readTool' | 'readArgs' | 'invalidArgs'

/** A JSON object, as the call seeds give tool arguments. */
const JsonObject = Schema.Record(Schema.String, Schema.Json)

const decodeJsonObjectText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))

/** A tool name: 1 to 128 printable ASCII characters without spaces. */
const ToolName = Schema.String.check(Schema.isPattern(/^[\x21-\x7E]{1,128}$/))

/** Tool arguments as JSON text that parses to an object. */
const JsonObjectText = Schema.String.check(
  Schema.makeFilter(text => Option.isSome(decodeJsonObjectText(text)))
)

/** The seeds as the shared runner keeps them: plain strings (JSON for the arguments). */
export const McpRunnerSeeds = Schema.Struct({
  readTool: Schema.optionalKey(ToolName),
  readArgs: Schema.optionalKey(JsonObjectText),
  invalidArgs: Schema.optionalKey(JsonObjectText)
})

export type McpRunnerSeeds = typeof McpRunnerSeeds.Type

/** The provider targets this runner knows. */
export const mcpRunnerTargets = ['afloat'] as const

export type McpRunnerTarget = (typeof mcpRunnerTargets)[number]

export const missingTargetMessage =
  '--target is required: afloat (the only available MCP target; figma is not available yet)'

export const figmaBlockedMessage =
  '--target figma is not available yet: it needs an owner-approved Figma practice seat and token, and the owner has not approved one'

/** The chosen target and the arguments left for the shared parser. */
export type McpTargetSelection = {
  readonly target: McpRunnerTarget
  readonly rest: ReadonlyArray<string>
}

/**
 * Take `--target <name>` (or `--target=<name>`) out of the arguments. Throws when it is missing,
 * repeated, blocked (`figma`), or unknown; the rest goes to the shared parser.
 */
export const parseMcpTarget = (argv: ReadonlyArray<string>): McpTargetSelection => {
  const rest: Array<string> = []
  const targets: Array<string> = []

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''

    if (argument === '--target') {
      const value = argv[++index]

      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        throw new Error('--target requires a value')
      }

      targets.push(value)
    } else if (argument.startsWith('--target=')) {
      targets.push(argument.slice('--target='.length))
    } else {
      rest.push(argument)
    }
  }

  const [target, ...more] = targets

  if (target === undefined) {
    // `--help` alone still prints the usage.
    if (rest.includes('--help') || rest.includes('-h')) {
      return { target: 'afloat', rest }
    }

    throw new Error(missingTargetMessage)
  }

  if (more.length > 0) {
    throw new Error('--target takes one target')
  }

  if (target === 'figma') {
    throw new Error(figmaBlockedMessage)
  }

  if (target !== 'afloat') {
    // The value is never repeated: a mistyped argument can be a credential.
    throw new Error('Unknown --target: afloat is the only MCP target')
  }

  return { target, rest }
}

/**
 * Where each seed comes from: a flag only. No source names an environment variable, so an
 * inherited environment can never switch a tool call on.
 */
export const mcpSeedSources: ReadonlyArray<SeedSource<McpSeedKey>> = [
  {
    key: 'readTool',
    flag: '--read-tool',
    description: 'a read-only tool to call (the listing must mark it readOnlyHint: true)'
  },
  {
    key: 'readArgs',
    flag: '--read-args',
    description: 'JSON object of arguments that make --read-tool succeed'
  },
  {
    key: 'invalidArgs',
    flag: '--invalid-args',
    description: 'JSON object of arguments --read-tool rejects with a tool error'
  }
]

const fixtureSpec = (
  caseId: string,
  fileName: string,
  exportName: string,
  doc: string,
  seeds: ReadonlyArray<McpSeedKey> = []
): CaseSpec<McpSeedKey> => ({ caseId, seeds, optionalSeeds: [], fileName, exportName, doc })

/** Seeds each case needs, and the fixture module `--record` stages for it. */
export const afloatCaseSpecs: ReadonlyArray<CaseSpec<McpSeedKey>> = [
  fixtureSpec(
    'mcp.negotiation.era',
    'negotiation-era.ts',
    'afloatMcpNegotiationEraFixture',
    'The era probe answered with a modern discover result, then the stateless listing.'
  ),
  fixtureSpec(
    'mcp.modern.stateless',
    'modern-stateless.ts',
    'afloatMcpModernStatelessFixture',
    'A stateless listing and an absent-tool call: routing headers everywhere, no session id.'
  ),
  fixtureSpec(
    'mcp.transport.response-encoding',
    'response-encoding.ts',
    'afloatMcpResponseEncodingFixture',
    'Every answer to a request holds the response to it.'
  ),
  fixtureSpec(
    'mcp.tools.list',
    'tools-list.ts',
    'afloatMcpToolsListFixture',
    'The listing: keep only the published tool subset when promoting.'
  ),
  fixtureSpec(
    'mcp.tools.call-read',
    'call-read.ts',
    'afloatMcpCallReadFixture',
    'The precondition listing, then the named read tool answered with a tool result.',
    ['readTool', 'readArgs']
  ),
  fixtureSpec(
    'mcp.tools.call-tool-error',
    'call-tool-error.ts',
    'afloatMcpCallToolErrorFixture',
    'The precondition listing, then the named read tool with invalid arguments answered isError.',
    ['readTool', 'invalidArgs']
  ),
  fixtureSpec(
    'mcp.errors.unknown-tool',
    'unknown-tool.ts',
    'afloatMcpUnknownToolFixture',
    'The precondition listing, then the absent tool answered with a JSON-RPC error.'
  ),
  fixtureSpec(
    'mcp.auth.rejected',
    'auth-rejected.ts',
    'afloatMcpAuthRejectedFixture',
    'The era probe with the reserved invalid Afloat key, answered 401.'
  )
]

/** The calling cases: they run only when a person names the tool and its arguments. */
export const callingCaseIds: ReadonlyArray<string> = afloatCaseSpecs.flatMap(spec =>
  spec.seeds.length > 0 ? [spec.caseId] : []
)

/** Validate the raw seeds (`None` when any is invalid). */
export const decodeMcpSeeds = Schema.decodeUnknownOption(McpRunnerSeeds)

const parsedObject = (text: string | undefined) =>
  text === undefined ? undefined : Option.getOrUndefined(decodeJsonObjectText(text))

/** The `McpConformanceSeeds` of a run: the Afloat live seeds plus the named calls. */
export const mcpConformanceSeedsFor = (seeds: McpRunnerSeeds): McpConformanceSeeds => {
  const readArgs = parsedObject(seeds.readArgs)
  const invalidArgs = parsedObject(seeds.invalidArgs)

  const withRead: McpConformanceSeeds =
    seeds.readTool === undefined
      ? afloatMcpConformanceLiveSeeds
      : {
          ...afloatMcpConformanceLiveSeeds,
          readTool: { name: seeds.readTool, arguments: readArgs ?? {} }
        }

  return invalidArgs === undefined ? withRead : { ...withRead, invalidArguments: invalidArgs }
}

/** The committed fixtures' seeds, as runner strings (the synthetic read call). */
export const afloatRunnerFixtureSeeds: McpRunnerSeeds = {
  readTool: afloatMcpConformanceFixtureSeeds.readTool?.name ?? 'list-invoices',
  readArgs: JSON.stringify(afloatMcpConformanceFixtureSeeds.readTool?.arguments ?? {}),
  invalidArgs: JSON.stringify(afloatMcpConformanceFixtureSeeds.invalidArguments ?? {})
}

/** The public prefix of every Afloat key (the secret is the rest). */
const afloatKeyPrefix = 'afloat_'

/** The secret part of an Afloat key: everything after the public `afloat_` prefix. */
export const afloatKeySecretParts = (accessToken: string): ReadonlyArray<string> =>
  accessToken.startsWith(afloatKeyPrefix) ? [accessToken.slice(afloatKeyPrefix.length)] : []

/** The access token replay verification resolves: an `afloat_` key (replay never checks it). */
export const afloatReplayKey = 'afloat_replay-access-key'

/**
 * The case layer: the `HttpClient`, the target from the REAL `afloat.mcp_auth` over a static
 * credential (the key's format was checked before any request, so the action cannot refuse it),
 * and the seeds.
 */
export const afloatCasePorts = (
  http: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: McpRunnerSeeds
): Layer.Layer<McpConformanceRequirements> =>
  Layer.mergeAll(
    http,
    Layer.effect(
      McpConformanceTarget,
      makeAfloatMcpConformanceTarget().pipe(
        Effect.provide(staticCredentialResolverLayer(ApiKeyCredential.make({ key: accessToken }))),
        Effect.orDie
      )
    ),
    Layer.succeed(McpConformanceConfig, mcpConformanceSeedsFor(seeds))
  )

/** The cases that apply to Afloat (the modern era), in case order. */
export const afloatCases = selectMcpConformanceCases(mcpConformanceCases, 'modern').applicable

export const afloatRunner = {
  provider: 'mcp/afloat',
  command: 'pnpm conformance:mcp --target afloat',
  fixturesDir: 'packages/connectors/src/afloat/conformance/',
  displayName: 'Afloat MCP',
  practiceTarget: 'a practice Afloat account with no real customers',
  tokenEnv: 'AFLOAT_API_KEY',
  tokenScopes:
    "a practice Afloat account's API key (afloat_...); every case is a read, and a tool is called only when named with --read-tool",
  endpoint: afloatMcpServerUrl,
  cases: afloatCases,
  seedSources: mcpSeedSources,
  caseSpecs: afloatCaseSpecs,
  fixtureSeeds: afloatRunnerFixtureSeeds,
  seedNoun: 'tool calls',
  seedsTypeName: 'McpRunnerSeeds',
  seedsExportName: 'afloatRunnerFixtureSeeds',
  configName: 'McpConformanceConfig',
  decodeSeeds: decodeMcpSeeds,
  invalidSeedsMessage:
    '--read-tool must be a tool name (1 to 128 printable ASCII characters, no spaces), and --read-args and --invalid-args JSON objects',
  casePorts: afloatCasePorts,
  recordedRequestHeaders: ['mcp-method', 'mcp-name', 'mcp-protocol-version'],
  recordedResponseHeaders: ['www-authenticate'],
  replayAccessToken: afloatReplayKey,
  // Checked before any request, never printed; afloat.mcp_auth requires the prefix too.
  tokenFormat: {
    pattern: /^afloat_[A-Za-z0-9]{16,256}$/,
    description: 'an Afloat API key: afloat_ followed by 16 to 256 letters and digits'
  },
  // The prefix is public; the remainder is the whole secret, so an echo of it alone is a leak.
  tokenSecretParts: afloatKeySecretParts,
  recoveryAdvice:
    'Every case is a read; nothing was created except, when --read-tool named a download-grant tool, a one-hour grant that expires by itself.',
  nameKeys: /^(?:name|title|description)$/,
  textKeys: /^(?:text|notes|message)$/,
  listEveryString: true,
  reviewNotice: {
    heading:
      'REVIEW before promoting (staged files hold practice-account data, and this repository is public):',
    seeds: 'the seeds name a practice tool call; replace its arguments with synthetic values',
    promote:
      'replace every tools/call answer body wholesale with a minimal synthetic body that keeps only the keys and types the case reads, keep only the published tool subset in the listing (never scrub field by field)',
    stagedFixture: 'replaced wholesale and promoted by hand',
    stagedSeeds: 'a replaced recording'
  }
} satisfies ConnectorConformanceRunner<
  McpSeedKey,
  McpRunnerSeeds,
  McpConformanceError,
  McpConformanceRequirements
>

/**
 * The runner for a live run: without the seeds a calling case needs, that case is left out (it
 * never runs, so no tool is called), instead of refusing the whole run.
 */
export const liveRunnerFor = (options: RunOptions<McpSeedKey>): typeof afloatRunner => {
  const ready = (caseId: string) =>
    (afloatCaseSpecs.find(spec => spec.caseId === caseId)?.seeds ?? []).every(
      key => options.seeds[key] !== undefined
    )

  return {
    ...afloatRunner,
    cases: afloatCases.filter(
      testCase => !callingCaseIds.includes(testCase.id) || ready(testCase.id)
    )
  }
}

/** The dry run: the shared plan, plus the cases the era filter leaves out and why. */
export const mcpDryRunReport = (options: RunOptions<McpSeedKey>): string => {
  const notApplicable = selectMcpConformanceCases(mcpConformanceCases, 'modern').notApplicable

  // A calling case without its seeds is left out of a live run (`liveRunnerFor`), not refused.
  const plan = dryRunReport(afloatRunner, options)
    .split('\n')
    .map(line => {
      const called = callingCaseIds.find(id => line.startsWith(`RUN   ${id}  `))

      return called !== undefined && line.includes('  needs ')
        ? line.replace('RUN ', 'SKIP').replace('  needs ', '  calls a tool only with ')
        : line
    })

  return [
    ...plan,
    ...notApplicable.map(
      entry =>
        `N/A   ${entry.id}  ${afloatMcpConformanceNotApplicable.find(known => known.id === entry.id)?.reason ?? entry.reason}`
    ),
    'Tool calls: mcp.tools.call-read runs only with --read-tool and --read-args, mcp.tools.call-tool-error only with --read-tool and --invalid-args; the absent-tool calls send only a tool name the listing proves absent.'
  ].join('\n')
}

/** Everything the CLI does besides running live; injectable for tests. */
export type McpCliIo = {
  readonly out: (line: string) => void
  readonly error: (line: string) => void
  readonly setExitCode: (code: number) => void
}

/**
 * Parse the arguments, then print usage, the dry run, or a refusal; answers the live run to start
 * (`undefined` when nothing runs live). Never reads a credential unless `--live` passed every gate.
 */
export const prepareMcpRun = (
  argv: ReadonlyArray<string>,
  env: ProbeEnv,
  io: McpCliIo
):
  | {
      readonly runner: typeof afloatRunner
      readonly options: RunOptions<McpSeedKey>
      readonly inputs: LiveInputs<McpRunnerSeeds>
    }
  | undefined => {
  let options: RunOptions<McpSeedKey>

  try {
    const { rest } = parseMcpTarget(argv)

    options = parseRunArgs(afloatRunner, rest, env)
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error))
    io.setExitCode(1)

    return undefined
  }

  if (options.help) {
    io.out(
      [
        usage(afloatRunner),
        '',
        'Targets: --target afloat (required). figma is not available yet.',
        'Tool calls: --read-tool <name> with --read-args <json> (mcp.tools.call-read) or --invalid-args <json> (mcp.tools.call-tool-error); without them no tool is called but the absent one.'
      ].join('\n')
    )

    return undefined
  }

  if (!options.live) {
    io.out(mcpDryRunReport(options))

    return undefined
  }

  const runner = liveRunnerFor(options)
  const checked = liveInputs(runner, options, env)

  if ('refusal' in checked) {
    io.error(checked.refusal)
    io.setExitCode(1)

    return undefined
  }

  return { runner, options, inputs: checked.inputs }
}

/** The CLI: `prepareMcpRun`, then the interruptible live run (redacted of the live key). */
export const runMcpConformanceCli = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
  env: ProbeEnv = process.env
): void => {
  const prepared = prepareMcpRun(argv, env, {
    out: line => console.log(line),
    error: line => console.error(line),
    setExitCode: code => {
      process.exitCode = code
    }
  })

  if (prepared === undefined) {
    return
  }

  const { runner, options, inputs } = prepared
  const cliIo: CliIo = runnerLiveSecrets(runner, inputs).reduce(redactingCliIo, processCliIo)

  void runInterruptibly(runLive(runner, options, inputs), processSignals, cliIo, {
    afterInterrupt: leftoverWarnings(
      runner,
      options,
      inputs,
      FetchHttpClient.layer,
      'after-interrupt'
    ),
    ...interruptOptionsFor(runner)
  })
}

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runMcpConformanceCli()
}
