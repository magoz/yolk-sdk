import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult, type ToolCall } from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  modelVisibleToolError,
  type ModelVisibleToolError,
  type ToolModule,
  type ToolRegistryError
} from '@yolk-sdk/agent/tools'
import {
  maxSandboxCommandTimeoutMs,
  normalizeWorkspaceCwd,
  sandboxCommandTimeoutMs,
  sandboxToolOutputLimit,
  validateSandboxCommand
} from './lifecycle.ts'
import type { SandboxError, SandboxExpiredError, SandboxInputError } from './errors.ts'
import type { SandboxApi } from './service.ts'
import { Sandbox } from './service.ts'
import type { SandboxCommandResult } from './model.ts'

export const sandboxToolName = 'sandbox'

const SandboxToolParams = Schema.Struct({
  command: Schema.String.pipe(
    Schema.annotate({ description: 'Shell command to run. Multiline commands are allowed.' })
  ),
  cwd: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.annotate({ description: 'Workspace-relative working directory. Absolute paths are rejected.' })
      )
    )
  ),
  stdin: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.annotate({ description: 'Optional stdin text passed to the command.' })
      )
    )
  ),
  timeoutSeconds: Schema.optional(
    Schema.NullOr(
      Schema.Number.pipe(
        Schema.annotate({ description: 'Foreground timeout in seconds. Default 120, max 600.' })
      )
    )
  ),
  background: Schema.optional(
    Schema.NullOr(
      Schema.Boolean.pipe(
        Schema.annotate({ description: 'Start command in background and return after a quick probe.' })
      )
    )
  )
})

export type SandboxToolParams = typeof SandboxToolParams.Type

export type SandboxToolModuleOptions<Context> = {
  readonly capabilities?: ReadonlyArray<string>
  readonly workspaceDescription?: string
  readonly lifecycleDescription?: string
  readonly previewPorts?: ReadonlyArray<number>
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
}

export type SandboxToolStructuredContent = {
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly workspaceReset: boolean
  readonly backgroundId?: string
  readonly previewUrls: SandboxCommandResult['previewUrls']
  readonly state: SandboxCommandResult['state']
}

type OutputSlice = {
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

const nullToUndefined = <A>(value: A | null | undefined) => value === null ? undefined : value

const toolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: sandboxToolName,
    message,
    cause
  })

const modelVisibleSandboxError = (
  error: SandboxInputError | SandboxExpiredError
): ModelVisibleToolError => {
  switch (error._tag) {
    case 'SandboxInputError':
      return modelVisibleToolError({
        tool: sandboxToolName,
        message: error.message,
        reason: 'invalid_input'
      })
    case 'SandboxExpiredError':
      return modelVisibleToolError({
        tool: sandboxToolName,
        message: error.message,
        reason: 'unavailable',
        details: { expiredAtMs: error.expiredAtMs }
      })
  }
}

const sandboxInfraToolError = (error: Exclude<SandboxError, SandboxInputError | SandboxExpiredError>) => {
  switch (error._tag) {
    case 'SandboxConfigError':
      return toolError(error.message, 'invalid_input')
    case 'SandboxProviderError':
      return toolError(error.message, 'execution')
    case 'SandboxStateError':
    case 'SandboxStateStoreError':
      return toolError(error.message, 'unavailable')
  }
}

const normalizeTimeoutMs = (timeoutSeconds: number | null | undefined) => {
  const value = nullToUndefined(timeoutSeconds)

  if (value === undefined) {
    return Effect.succeed(sandboxCommandTimeoutMs(undefined))
  }

  if (!Number.isFinite(value) || value <= 0) {
    return Effect.fail(
      modelVisibleToolError({
        tool: sandboxToolName,
        message: 'timeoutSeconds must be greater than 0',
        reason: 'invalid_input'
      })
    )
  }

  return Effect.succeed(sandboxCommandTimeoutMs(Math.floor(value * 1_000)))
}

const normalizeToolParams = (params: SandboxToolParams) =>
  Effect.gen(function* () {
    const command = yield* validateSandboxCommand(params.command).pipe(
      Effect.mapError(modelVisibleSandboxError)
    )
    const cwd = yield* normalizeWorkspaceCwd(params.cwd).pipe(
      Effect.mapError(modelVisibleSandboxError)
    )
    const timeoutMs = yield* normalizeTimeoutMs(params.timeoutSeconds)

    return {
      command,
      cwd,
      stdin: nullToUndefined(params.stdin),
      timeoutMs,
      background: nullToUndefined(params.background)
    }
  })

const truncateOutputs = (stdout: string, stderr: string, limit: number): OutputSlice => {
  if (stdout.length + stderr.length <= limit) {
    return { stdout, stderr, truncated: false }
  }

  const initialStderrBudget = Math.min(stderr.length, Math.floor(limit / 2))
  const initialStdoutBudget = Math.min(stdout.length, limit - initialStderrBudget)
  const unused = limit - initialStdoutBudget - initialStderrBudget
  const stdoutBudget = Math.min(stdout.length, initialStdoutBudget + unused)
  const stderrBudget = Math.min(stderr.length, limit - stdoutBudget)

  return {
    stdout: stdout.slice(0, stdoutBudget),
    stderr: stderr.slice(0, stderrBudget),
    truncated: true
  }
}

const formatSandboxToolContent = (result: SandboxCommandResult, output: OutputSlice) =>
  [
    `exit_code: ${result.exitCode === null ? 'null' : String(result.exitCode)}`,
    `duration_ms: ${result.durationMs}`,
    `truncated: ${output.truncated}`,
    `timed_out: ${result.timedOut}`,
    `workspace_reset: ${result.workspaceReset}`,
    result.backgroundId === undefined ? undefined : `background_id: ${result.backgroundId}`,
    '<stdout>',
    output.stdout,
    '</stdout>',
    '<stderr>',
    output.stderr,
    '</stderr>'
  ].filter(line => line !== undefined).join('\n')

const structuredContent = (
  result: SandboxCommandResult,
  truncated: boolean
): SandboxToolStructuredContent => ({
  exitCode: result.exitCode,
  durationMs: result.durationMs,
  timedOut: result.timedOut,
  truncated,
  workspaceReset: result.workspaceReset,
  ...(result.backgroundId === undefined ? {} : { backgroundId: result.backgroundId }),
  previewUrls: result.previewUrls,
  state: result.state
})

export const makeSandboxToolResult = (input: {
  readonly callId: string
  readonly result: SandboxCommandResult
}) => {
  const output = truncateOutputs(input.result.stdout, input.result.stderr, sandboxToolOutputLimit)

  return ToolResult.make({
    toolCallId: input.callId,
    content: formatSandboxToolContent(input.result, output),
    isError: input.result.timedOut || (input.result.exitCode !== null && input.result.exitCode !== 0),
    structuredContent: structuredContent(input.result, output.truncated)
  })
}

const sandboxToolDescription = <Context>(options: SandboxToolModuleOptions<Context>) => {
  const capabilities = options.capabilities ?? [
    'run project commands such as typechecks, lint, tests, and builds',
    'edit files with shell tools such as apply_patch when available',
    'start dev servers and use preview ports',
    'run browser checks through agent-browser when available'
  ]
  const ports = options.previewPorts ?? []

  return [
    'Run one non-interactive bash command inside a real sandbox workspace.',
    options.workspaceDescription ?? 'The working directory is the sandbox workspace root.',
    options.lifecycleDescription ?? 'The sandbox is disposable and may reset after idle or max lifetime expiry.',
    `Foreground timeout defaults to 120s and is capped at ${Math.floor(maxSandboxCommandTimeoutMs / 1_000)}s.`,
    'Use workspace-relative cwd only; absolute paths and workspace escapes are rejected.',
    'Use stdin for large patches, scripts, or data.',
    'Set background=true for long-running servers; the tool returns after a quick probe.',
    ports.length === 0 ? 'Preview URLs are returned when configured by the host.' : `Preview ports: ${ports.join(', ')}.`,
    `Available capabilities:\n${capabilities.map(capability => `- ${capability}`).join('\n')}`
  ].join('\n\n')
}

export const makeSandboxToolModuleFromApi = <Context>(
  sandbox: SandboxApi,
  options: SandboxToolModuleOptions<Context> = {}
): ToolModule<Context> => ({
  id: 'sandbox',
  tools: [
    makeTool({
      name: sandboxToolName,
      description: sandboxToolDescription(options),
      parameters: SandboxToolParams,
      access: 'destructive',
      isEnabled: options.isEnabled,
      invalidParamsMessage: error => `Invalid sandbox arguments: ${error instanceof Error ? error.message : String(error)}`,
      execute: ({ call, params }) =>
        Effect.gen(function* () {
          if (call.name !== sandboxToolName) {
            return yield* Effect.fail(toolError(`Tool is not configured: ${call.name}`, 'not_found'))
          }

          const normalized = yield* normalizeToolParams(params)
          const result = yield* sandbox.run(normalized).pipe(
            Effect.mapError(error => {
              switch (error._tag) {
                case 'SandboxInputError':
                case 'SandboxExpiredError':
                  return modelVisibleSandboxError(error)
                case 'SandboxConfigError':
                case 'SandboxProviderError':
                case 'SandboxStateError':
                case 'SandboxStateStoreError':
                  return sandboxInfraToolError(error)
              }
            })
          )

          return makeSandboxToolResult({ callId: call.id, result })
        })
    })
  ]
})

export const makeSandboxToolModule = <Context>(
  options: SandboxToolModuleOptions<Context> = {}
): Effect.Effect<ToolModule<Context>, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox
    return makeSandboxToolModuleFromApi(sandbox, options)
  })

export type SandboxToolExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
  readonly params: SandboxToolParams
}
