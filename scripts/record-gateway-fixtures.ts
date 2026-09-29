/**
 * Vercel AI Gateway wire-fixture probe.
 *
 * Default: DRY RUN. Prints the four planned requests and exits without any
 * network call.
 *
 * `--live`: requires `AI_GATEWAY_API_KEY`, runs the real Gateway provider over
 * the conformance recorder wrapped around a real fetch `HttpClient`, and
 * rewrites the fixture modules under
 * `packages/agent/src/providers/vercel/conformance/` as `verified` recordings
 * dated today. Nothing is written unless all four cases record cleanly and
 * pass the secret scan. Live runs spend Gateway credits: never run in CI.
 *
 * Model ids are CLI flags; confirm the defaults are still available on the
 * Gateway before a live probe.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Redacted, Result, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient } from 'effect/unstable/http'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import { UserMessage, ToolResult } from '@yolk-sdk/agent/protocol'
import { makeTool } from '@yolk-sdk/agent/tools'
import {
  makeVercelAiGatewayProviderLayer,
  vercelAiGatewayChatCompletionsUrl,
  type VercelAiGatewayProviderConfig
} from '@yolk-sdk/agent/providers/vercel/ai-gateway-provider'
import type { WireFixture } from '../packages/conformance/src/fixture.ts'
import { makeWireFixture, WireRecorder } from '../packages/conformance/src/record.ts'

export type ProbeOptions = {
  readonly live: boolean
  readonly help: boolean
  readonly plainModel: string
  readonly reasoningModel: string
  readonly toolModel: string
  readonly invalidModel: string
  readonly maxTokens: number
  readonly reasoningMaxTokens: number
  readonly reasoningEffort: AgentReasoningEffort
  readonly account: string
}

type MutableProbeOptions = { -readonly [Key in keyof ProbeOptions]: ProbeOptions[Key] }

export const defaultProbeOptions: ProbeOptions = {
  live: false,
  help: false,
  plainModel: 'openai/gpt-4.1-nano',
  reasoningModel: 'deepseek/deepseek-v3.2',
  toolModel: 'openai/gpt-4.1-nano',
  invalidModel: 'yolk-conformance/model-does-not-exist',
  maxTokens: 64,
  reasoningMaxTokens: 512,
  reasoningEffort: 'low',
  account: 'gateway-practice'
}

const reasoningEfforts: ReadonlyArray<AgentReasoningEffort> = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]

const usage = `Usage: pnpm conformance:gateway [--live] [options]

Dry run by default: prints the planned requests and performs no network I/O.

Options:
  --live                          Record against the real Gateway (needs AI_GATEWAY_API_KEY)
  --plain-model <id>              default ${defaultProbeOptions.plainModel}
  --reasoning-model <id>          default ${defaultProbeOptions.reasoningModel} (DeepSeek-style reasoning_content)
  --tool-model <id>               default ${defaultProbeOptions.toolModel}
  --invalid-model <id>            default ${defaultProbeOptions.invalidModel} (must NOT exist)
  --max-tokens <n>                default ${defaultProbeOptions.maxTokens}
  --reasoning-max-tokens <n>      default ${defaultProbeOptions.reasoningMaxTokens}
  --reasoning-effort <effort>     default ${defaultProbeOptions.reasoningEffort}
  --account <label>               synthetic account label, default ${defaultProbeOptions.account}
  --help

Confirm model ids are available on the Gateway before a live probe. Review the
rewritten fixtures before committing: they must contain synthetic content only.`

const positiveInteger = (flag: string, value: string): number => {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

/** Parse CLI arguments (without the node/script prefix). Throws on unknown flags. */
export const parseProbeArgs = (argv: ReadonlyArray<string>): ProbeOptions => {
  const options: MutableProbeOptions = { ...defaultProbeOptions }

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

    switch (flag) {
      case '--live':
        options.live = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      case '--plain-model':
        options.plainModel = value()
        break
      case '--reasoning-model':
        options.reasoningModel = value()
        break
      case '--tool-model':
        options.toolModel = value()
        break
      case '--invalid-model':
        options.invalidModel = value()
        break
      case '--max-tokens':
        options.maxTokens = positiveInteger(flag, value())
        break
      case '--reasoning-max-tokens':
        options.reasoningMaxTokens = positiveInteger(flag, value())
        break
      case '--reasoning-effort': {
        const effort = value()
        const known = reasoningEfforts.find(candidate => candidate === effort)

        if (known === undefined) {
          throw new Error(`--reasoning-effort must be one of ${reasoningEfforts.join(', ')}`)
        }

        options.reasoningEffort = known
        break
      }

      case '--account':
        options.account = value()
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return options
}

export type ProbeCase = {
  readonly caseId: string
  readonly exportName: string
  readonly fileName: string
  readonly doc: string
  readonly expect: 'success' | 'error'
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly withTool: boolean
  readonly prompt: string
  /** Provider config without the credential. */
  readonly config: Omit<VercelAiGatewayProviderConfig, 'apiKey'>
}

const systemPrompt = 'Reply in one short sentence.'

/** The four planned Gateway requests. Pure: used by the dry run and the live probe. */
export const plannedGatewayProbeCases = (options: ProbeOptions): ReadonlyArray<ProbeCase> => [
  {
    caseId: 'vercel-ai-gateway.stream.plain-text',
    exportName: 'vercelAiGatewayPlainTextFixture',
    fileName: 'plain-text.ts',
    doc: 'Streamed plain-text answer: text deltas, a finish chunk, a usage chunk, and `data: [DONE]`.',
    expect: 'success',
    model: options.plainModel,
    withTool: false,
    prompt: 'Say hello.',
    config: { maxCompletionTokens: options.maxTokens, streaming: true }
  },
  {
    caseId: 'vercel-ai-gateway.stream.deepseek-reasoning',
    exportName: 'vercelAiGatewayDeepSeekReasoningFixture',
    fileName: 'deepseek-reasoning.ts',
    doc: 'DeepSeek-style streamed reasoning (`delta.reasoning_content`) before the answer text, requested with `reasoning_effort` and a `thinking` toggle.',
    expect: 'success',
    model: options.reasoningModel,
    reasoningEffort: options.reasoningEffort,
    withTool: false,
    prompt: 'Say hello.',
    config: {
      maxCompletionTokens: options.reasoningMaxTokens,
      streaming: true,
      reasoningContent: true,
      reasoningEffortFormat: 'reasoning-effort',
      thinking: { type: 'enabled' }
    }
  },
  {
    caseId: 'vercel-ai-gateway.stream.tool-call-deltas',
    exportName: 'vercelAiGatewayToolCallDeltasFixture',
    fileName: 'tool-call-deltas.ts',
    doc: 'Streamed tool call whose JSON arguments arrive across several `delta.tool_calls` chunks.',
    expect: 'success',
    model: options.toolModel,
    withTool: true,
    prompt: 'What is the weather in Springfield? Use the tool.',
    config: { maxCompletionTokens: options.maxTokens, streaming: true }
  },
  {
    caseId: 'vercel-ai-gateway.stream.error-envelope',
    exportName: 'vercelAiGatewayErrorEnvelopeFixture',
    fileName: 'error-envelope.ts',
    doc: 'Non-2xx JSON error envelope for a request with an invalid model id.',
    expect: 'error',
    model: options.invalidModel,
    withTool: false,
    prompt: 'Say hello.',
    config: { maxCompletionTokens: options.maxTokens, streaming: true }
  }
]

export const dryRunReport = (options: ProbeOptions): string =>
  [
    'DRY RUN: no network request was made. Pass --live to record (needs AI_GATEWAY_API_KEY).',
    `Endpoint: ${vercelAiGatewayChatCompletionsUrl}`,
    ...plannedGatewayProbeCases(options).map(probe =>
      JSON.stringify(
        {
          caseId: probe.caseId,
          model: probe.model,
          expect: probe.expect,
          reasoningEffort: probe.reasoningEffort,
          tools: probe.withTool ? ['lookup_weather'] : [],
          config: probe.config
        },
        null,
        2
      )
    ),
    'Confirm model ids are available on the Gateway before a live probe.'
  ].join('\n')

const lookupWeatherTool = makeTool({
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: Schema.Struct({ city: Schema.String }),
  access: 'read',
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'sunny' }))
})

class ProbeCaseFailed extends Schema.TaggedError<ProbeCaseFailed>()('ProbeCaseFailed', {
  caseId: Schema.String,
  message: Schema.String
}) {}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureDir = join(workspaceRoot, 'packages/agent/src/providers/vercel/conformance')

const today = () => new Date().toISOString().slice(0, 10)

const recordCase = (probe: ProbeCase, apiKey: Redacted.Redacted<string>, options: ProbeOptions) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider
    const recorder = yield* WireRecorder

    const request = {
      model: probe.model,
      systemPrompt,
      messages: [UserMessage.make({ content: probe.prompt })],
      tools: probe.withTool ? [lookupWeatherTool.def] : []
    }

    const outcome = yield* provider
      .stream(
        probe.reasoningEffort === undefined
          ? request
          : { ...request, reasoningEffort: probe.reasoningEffort }
      )
      .pipe(Stream.runCollect, Effect.result)

    if (probe.expect === 'success' && Result.isFailure(outcome)) {
      return yield* new ProbeCaseFailed({
        caseId: probe.caseId,
        message: `expected success, got ${outcome.failure.cause}: ${outcome.failure.message}`
      })
    }

    if (probe.expect === 'error' && Result.isSuccess(outcome)) {
      return yield* new ProbeCaseFailed({
        caseId: probe.caseId,
        message: 'expected an error envelope but the request succeeded'
      })
    }

    const exchanges = yield* recorder.drain

    if (exchanges.length !== 1) {
      return yield* new ProbeCaseFailed({
        caseId: probe.caseId,
        message: `expected exactly one exchange, recorded ${exchanges.length}`
      })
    }

    return yield* makeWireFixture({
      id: `${probe.caseId}.recorded`,
      caseId: probe.caseId,
      evidence: 'verified',
      recordedAt: today(),
      account: options.account,
      endpoint: vercelAiGatewayChatCompletionsUrl,
      model: probe.model,
      note: 'Recorded from the live Vercel AI Gateway by scripts/record-gateway-fixtures.ts --live. Prompts and outputs are synthetic.',
      exchanges
    })
  }).pipe(
    Effect.provide(
      makeVercelAiGatewayProviderLayer({ ...probe.config, apiKey }).pipe(
        Layer.provideMerge(WireRecorder.layer().pipe(Layer.provide(FetchHttpClient.layer)))
      )
    )
  )

export const renderFixtureModule = (probe: ProbeCase, fixture: WireFixture): string =>
  [
    "import type { WireFixture } from '@yolk-sdk/conformance/fixture'",
    '',
    '/**',
    ` * ${probe.doc}`,
    ' *',
    ` * Verified recording (${fixture.recordedAt}). Regenerate with`,
    ' * `scripts/record-gateway-fixtures.ts --live`.',
    ' */',
    `export const ${probe.exportName}: WireFixture = ${JSON.stringify(fixture, null, 2)}`,
    ''
  ].join('\n')

const live = (options: ProbeOptions) =>
  Effect.gen(function* () {
    const key = process.env.AI_GATEWAY_API_KEY

    if (key === undefined || key.trim().length === 0) {
      return yield* new ProbeCaseFailed({
        caseId: '*',
        message: 'AI_GATEWAY_API_KEY is required for --live'
      })
    }

    const apiKey = Redacted.make(key)
    const cases = plannedGatewayProbeCases(options)

    // Record everything first; write nothing unless every case succeeded.
    const recorded = yield* Effect.forEach(cases, probe =>
      recordCase(probe, apiKey, options).pipe(Effect.map(fixture => ({ probe, fixture })))
    )

    const files = recorded.map(({ probe, fixture }) => {
      const file = join(fixtureDir, probe.fileName)

      writeFileSync(file, renderFixtureModule(probe, fixture))

      return file
    })

    execFileSync('pnpm', ['exec', 'oxfmt', '--write', ...files], {
      cwd: workspaceRoot,
      stdio: 'inherit'
    })

    console.log(`Wrote ${files.length} verified fixtures. Review them before committing.`)
  })

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  const options = parseProbeArgs(process.argv.slice(2))

  if (options.help) {
    console.log(usage)
  } else if (!options.live) {
    console.log(dryRunReport(options))
  } else {
    Effect.runPromise(live(options)).catch(error => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
  }
}
