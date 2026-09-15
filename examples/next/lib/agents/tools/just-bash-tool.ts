import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { Bash } from 'just-bash/browser'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult, type ToolCall } from '@yolk-sdk/agent/protocol'
import { makeTool, type ToolModule, type ToolRegistration } from '@yolk-sdk/agent/tools'
import type { AgentToolContext } from './tool-context.ts'

const justBashToolName = 'just_bash'

const defaultTimeoutSeconds = 10

const maxTimeoutSeconds = 30

const maxOutputCharacters = 20_000

const JustBashParams = Schema.Struct({
  script: Schema.String.pipe(
    Schema.annotate({
      description: 'Bash script to run inside an isolated just-bash virtual filesystem.'
    })
  ),
  cwd: Schema.optional(Schema.String).pipe(
    Schema.annotate({ description: 'Optional virtual working directory. Defaults to /home/user.' })
  ),
  stdin: Schema.optional(Schema.String).pipe(
    Schema.annotate({ description: 'Optional stdin text passed to the script.' })
  ),
  timeoutSeconds: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Optional timeout in seconds. Defaults to 10; capped at 30.' })
  )
})

type JustBashParams = typeof JustBashParams.Type

const justBashToolDescription = [
  'Run bash in a just-bash virtual filesystem.',
  'Use for safe text, JSON, YAML, CSV, file-processing, and curl pipelines with built-in Unix tools.',
  'Network access is enabled but private/loopback ranges are blocked.',
  'No host filesystem access, external binaries, persistent state, JS, or Python is available.'
].join(' ')

const schemaErrorToMessage = (error: Schema.SchemaError) => String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: justBashToolName,
    message,
    cause
  })

type JustBashExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const isJustBashTimeoutError = (error: Error | DOMException) =>
  error.name === 'AbortError' ||
  error.name === 'TimeoutError' ||
  error.name === 'ExecutionAbortedError'

export const justBashHostFailure = (error: unknown) => {
  if (
    (Predicate.isError(error) || error instanceof DOMException) &&
    isJustBashTimeoutError(error)
  ) {
    const message = error.message.trim()

    return makeToolError(
      message.length === 0
        ? 'just-bash execution timed out'
        : `just-bash execution timed out: ${message}`,
      'timeout'
    )
  }

  if (Predicate.isError(error) || error instanceof DOMException) {
    const message = error.message.trim()

    return makeToolError(
      message.length === 0
        ? 'just-bash execution failed'
        : `just-bash execution failed: ${message}`,
      'execution'
    )
  }

  return makeToolError('just-bash execution failed', 'execution')
}

const resolveTimeoutMs = (timeoutSeconds: number | undefined) => {
  const timeout = timeoutSeconds ?? defaultTimeoutSeconds

  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Effect.fail(
      makeToolError('timeoutSeconds must be a positive finite number', 'validation')
    )
  }

  return Effect.succeed(Math.min(timeout, maxTimeoutSeconds) * 1000)
}

const truncate = (value: string) =>
  value.length <= maxOutputCharacters
    ? value
    : `${value.slice(0, maxOutputCharacters)}\n[truncated ${value.length - maxOutputCharacters} chars]`

const runWithTimeout = (params: JustBashParams, timeoutMs: number) =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const bash = new Bash({
          cwd: params.cwd ?? '/home/user',
          network: {
            dangerouslyAllowFullInternetAccess: true,
            denyPrivateRanges: true,
            _dnsResolve: async () => [],
            maxRedirects: 5,
            maxResponseSize: 5 * 1024 * 1024,
            timeoutMs
          },
          executionLimits: {
            maxCommandCount: 10_000,
            maxLoopIterations: 10_000,
            maxCallDepth: 100,
            maxStringLength: maxOutputCharacters
          }
        })

        const result = await bash.exec(params.script, {
          stdin: params.stdin,
          signal: controller.signal,
          rawScript: true
        })

        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: controller.signal.aborted
        } satisfies JustBashExecResult
      } finally {
        clearTimeout(timeoutId)
      }
    },
    catch: justBashHostFailure
  })

const formatResult = (input: JustBashExecResult) =>
  [
    ...(input.timedOut ? ['timed_out: true'] : []),
    `exit_code: ${input.exitCode}`,
    '<stdout>',
    truncate(input.stdout),
    '</stdout>',
    '<stderr>',
    truncate(input.stderr),
    '</stderr>'
  ].join('\n')

const justBashToolResult = (call: ToolCall, result: JustBashExecResult) =>
  ToolResult.make({
    toolCallId: call.id,
    content: formatResult(result),
    isError: result.timedOut || result.exitCode !== 0 ? true : undefined
  })

export const executeJustBashTool = (call: ToolCall) =>
  Effect.gen(function* () {
    const params = yield* Schema.decodeUnknownEffect(JustBashParams)(call.params).pipe(
      Effect.mapError(error =>
        makeToolError(`Invalid just-bash arguments: ${schemaErrorToMessage(error)}`, 'validation')
      )
    )

    const timeoutMs = yield* resolveTimeoutMs(params.timeoutSeconds)
    const result = yield* runWithTimeout(params, timeoutMs)

    return justBashToolResult(call, result)
  })

const justBashTool: ToolRegistration<AgentToolContext> = makeTool({
  name: justBashToolName,
  description: justBashToolDescription,
  parameters: JustBashParams,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text'),
  invalidParamsMessage: error => `Invalid just-bash arguments: ${schemaErrorToMessage(error)}`,
  execute: ({ call, params }) =>
    Effect.gen(function* () {
      const timeoutMs = yield* resolveTimeoutMs(params.timeoutSeconds)
      const result = yield* runWithTimeout(params, timeoutMs)

      return justBashToolResult(call, result)
    })
})

export const justBashToolModule: ToolModule<AgentToolContext> = {
  id: 'just-bash',
  tools: [justBashTool]
}
