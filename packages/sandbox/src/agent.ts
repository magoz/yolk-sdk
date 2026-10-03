import { Effect, Match } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult, type ToolCall } from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  withToolArgumentsErrorHint,
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
    Schema.annotate({
      description: 'Shell command to run. Multiline commands are allowed.'
    })
  ),
  cwd: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.annotate({
          description: 'Workspace-relative working directory. Absolute paths are rejected.'
        })
      )
    )
  ),
  stdin: Schema.optional(
    Schema.NullOr(
      Schema.String.pipe(
        Schema.annotate({
          description: 'Optional stdin text passed to the command.'
        })
      )
    )
  ),
  timeoutSeconds: Schema.optional(
    Schema.NullOr(
      Schema.Number.pipe(
        Schema.annotate({
          description: 'Foreground timeout in seconds. Default 120, max 600.'
        })
      )
    )
  ),
  background: Schema.optional(
    Schema.NullOr(
      Schema.Boolean.pipe(
        Schema.annotate({
          description: 'Start command in background and return after a quick probe.'
        })
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

const SandboxToolPreviewUrl = Schema.Struct({ port: Schema.Number, url: Schema.String })

const SandboxToolState = Schema.Struct({
  _tag: Schema.Literal('Vercel'),
  name: Schema.String,
  createdAtMs: Schema.Number,
  lastUsedAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
  maxExpiresAtMs: Schema.Number
})

/**
 * Declared output of the `sandbox` tool. `structuredContent` is plain JSON of this shape (already
 * its JSON encoding); `stdout`/`stderr` are the same bounded slices as the text content, and
 * `truncated` tells whether they were cut.
 */
export const SandboxToolOutput = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  durationMs: Schema.Number,
  timedOut: Schema.Boolean,
  truncated: Schema.Boolean,
  workspaceReset: Schema.Boolean,
  backgroundId: Schema.optionalKey(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  previewUrls: Schema.Array(SandboxToolPreviewUrl),
  state: SandboxToolState
})

export type SandboxToolStructuredContent = typeof SandboxToolOutput.Type

type PlainSandboxPreviewUrl = typeof SandboxToolPreviewUrl.Type

type PlainSandboxState = typeof SandboxToolState.Type

const sandboxToolModuleDescription =
  'Run shell commands in a host-provided sandbox workspace (files, project commands, background servers).'

type OutputSlice = {
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

const nullToUndefined = <A>(value: A | null | undefined) => (value === null ? undefined : value)

const toolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: sandboxToolName,
    message,
    cause
  })

const modelVisibleSandboxError = (
  error: SandboxInputError | SandboxExpiredError
): ModelVisibleToolError =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      SandboxInputError: inputError =>
        modelVisibleToolError({
          tool: sandboxToolName,
          message: inputError.message,
          reason: 'invalid_input'
        }),
      SandboxExpiredError: expiredError =>
        modelVisibleToolError({
          tool: sandboxToolName,
          message: expiredError.message,
          reason: 'unavailable',
          details: { expiredAtMs: expiredError.expiredAtMs }
        })
    })
  )

const sandboxInfraToolError = (
  error: Exclude<SandboxError, SandboxInputError | SandboxExpiredError>
) =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      SandboxConfigError: configError => toolError(configError.message, 'invalid_input'),
      SandboxProviderError: providerError => toolError(providerError.message, 'execution'),
      SandboxStateError: stateError => toolError(stateError.message, 'unavailable'),
      SandboxStateStoreError: storeError => toolError(storeError.message, 'unavailable')
    })
  )

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
  ]
    .filter(line => line !== undefined)
    .join('\n')

const plainSandboxPreviewUrl = (
  previewUrl: SandboxCommandResult['previewUrls'][number]
): PlainSandboxPreviewUrl => ({
  port: previewUrl.port,
  url: previewUrl.url
})

const plainSandboxState = (state: SandboxCommandResult['state']): PlainSandboxState =>
  Match.value(state._tag).pipe(
    Match.when('Vercel', () => ({
      _tag: state._tag,
      name: state.name,
      createdAtMs: state.createdAtMs,
      lastUsedAtMs: state.lastUsedAtMs,
      expiresAtMs: state.expiresAtMs,
      maxExpiresAtMs: state.maxExpiresAtMs
    })),
    Match.exhaustive
  )

type SandboxToolStructuredContentFields = {
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly workspaceReset: boolean
  backgroundId?: string
}

const structuredContent = (
  result: SandboxCommandResult,
  output: OutputSlice
): SandboxToolStructuredContent => {
  const content: SandboxToolStructuredContentFields = {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: output.truncated,
    workspaceReset: result.workspaceReset
  }

  if (result.backgroundId !== undefined) {
    content.backgroundId = result.backgroundId
  }

  return {
    ...content,
    stdout: output.stdout,
    stderr: output.stderr,
    previewUrls: result.previewUrls.map(plainSandboxPreviewUrl),
    state: plainSandboxState(result.state)
  }
}

export const makeSandboxToolResult = (input: {
  readonly callId: string
  readonly result: SandboxCommandResult
}) => {
  const output = truncateOutputs(input.result.stdout, input.result.stderr, sandboxToolOutputLimit)

  return ToolResult.make({
    toolCallId: input.callId,
    content: formatSandboxToolContent(input.result, output),
    isError:
      input.result.timedOut || (input.result.exitCode !== null && input.result.exitCode !== 0),
    structuredContent: structuredContent(input.result, output)
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
    options.lifecycleDescription ??
      'The sandbox is disposable and may reset after idle or max lifetime expiry.',
    `Foreground timeout defaults to 120s and is capped at ${Math.floor(maxSandboxCommandTimeoutMs / 1_000)}s.`,
    'Use workspace-relative cwd only; absolute paths and workspace escapes are rejected.',
    'Use stdin for large patches, scripts, or data.',
    'Set background=true for long-running servers; the tool returns after a quick probe.',
    ports.length === 0
      ? 'Preview URLs are returned when configured by the host.'
      : `Preview ports: ${ports.join(', ')}.`,
    `Available capabilities:\n${capabilities.map(capability => `- ${capability}`).join('\n')}`
  ].join('\n\n')
}

export const makeSandboxToolModuleFromApi = <Context>(
  sandbox: SandboxApi,
  options: SandboxToolModuleOptions<Context> = {}
): ToolModule<Context> => ({
  id: 'sandbox',
  description: sandboxToolModuleDescription,
  tools: [
    makeTool({
      name: sandboxToolName,
      description: sandboxToolDescription(options),
      parameters: SandboxToolParams,
      output: SandboxToolOutput,
      access: 'destructive',
      isEnabled: options.isEnabled,
      invalidParamsMessage: error =>
        withToolArgumentsErrorHint(
          `Invalid sandbox arguments: ${error instanceof Error ? error.message : String(error)}`,
          error
        ),
      execute: ({ call, params }) =>
        Effect.gen(function* () {
          if (call.name !== sandboxToolName) {
            return yield* Effect.fail(
              toolError(`Tool is not configured: ${call.name}`, 'not_found')
            )
          }

          const normalized = yield* normalizeToolParams(params)

          const result = yield* sandbox.run(normalized).pipe(
            Effect.mapError(error =>
              Match.value(error).pipe(
                Match.tagsExhaustive({
                  SandboxInputError: inputError => modelVisibleSandboxError(inputError),
                  SandboxExpiredError: expiredError => modelVisibleSandboxError(expiredError),
                  SandboxConfigError: configError => sandboxInfraToolError(configError),
                  SandboxProviderError: providerError => sandboxInfraToolError(providerError),
                  SandboxStateError: stateError => sandboxInfraToolError(stateError),
                  SandboxStateStoreError: storeError => sandboxInfraToolError(storeError)
                })
              )
            )
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
