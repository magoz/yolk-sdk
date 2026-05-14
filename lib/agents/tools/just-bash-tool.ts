import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { Bash } from 'just-bash/browser'
import { ToolError } from '@yolk/agent/loop'
import { ToolDef, ToolResult, type ToolCall } from '@yolk/agent/protocol'
import type { ToolModule, ToolRegistration } from '@yolk/agent/tools'
import type { AgentToolContext } from './tool-context.ts'

const justBashToolName = 'just_bash'
const defaultTimeoutSeconds = 10
const maxTimeoutSeconds = 30
const maxOutputCharacters = 20_000

const JustBashParams = Schema.Struct({
  script: Schema.String,
  cwd: Schema.optional(Schema.String),
  stdin: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})

type JustBashParams = typeof JustBashParams.Type

const justBashParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    script: {
      type: 'string',
      description: 'Bash script to run inside an isolated just-bash virtual filesystem.'
    },
    cwd: {
      type: 'string',
      description: 'Optional virtual working directory. Defaults to /home/user.'
    },
    stdin: {
      type: 'string',
      description: 'Optional stdin text passed to the script.'
    },
    timeoutSeconds: {
      type: 'number',
      description: 'Optional timeout in seconds. Defaults to 10; capped at 30.'
    }
  },
  required: ['script']
}

const justBashToolDef = ToolDef.make({
  name: justBashToolName,
  description: [
    'Run bash in a just-bash virtual filesystem.',
    'Use for safe text, JSON, YAML, CSV, file-processing, and curl pipelines with built-in Unix tools.',
    'Network access is enabled but private/loopback ranges are blocked.',
    'No host filesystem access, external binaries, persistent state, JS, or Python is available.'
  ].join(' '),
  parameters: justBashParameters
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: justBashToolName,
    message,
    cause
  })

const decodeJustBashParams = (params: unknown) =>
  Schema.decodeUnknownEffect(JustBashParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(`Invalid just-bash arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

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

        return await bash.exec(params.script, {
          stdin: params.stdin,
          signal: controller.signal,
          rawScript: true
        })
      } finally {
        clearTimeout(timeoutId)
      }
    },
    catch: error => makeToolError(`just-bash execution failed: ${unknownToMessage(error)}`, 'execution')
  })

const formatResult = (input: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}) =>
  [
    `exit_code: ${input.exitCode}`,
    '<stdout>',
    truncate(input.stdout),
    '</stdout>',
    '<stderr>',
    truncate(input.stderr),
    '</stderr>'
  ].join('\n')

export const executeJustBashTool = (call: ToolCall) =>
  Effect.gen(function* () {
    const params = yield* decodeJustBashParams(call.params)
    const timeoutMs = yield* resolveTimeoutMs(params.timeoutSeconds)
    const result = yield* runWithTimeout(params, timeoutMs)

    return ToolResult.make({
      toolCallId: call.id,
      content: formatResult(result)
    })
  })

const justBashTool: ToolRegistration<AgentToolContext> = {
  def: justBashToolDef,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text'),
  execute: ({ call }) => executeJustBashTool(call)
}

export const justBashToolModule: ToolModule<AgentToolContext> = {
  id: 'just-bash',
  tools: [justBashTool]
}
