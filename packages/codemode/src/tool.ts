import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Predicate,
  Scope
} from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  emptyNestedToolCallRecorder,
  nestedToolCallResultFields,
  recordNestedToolCall,
  contentPartText,
  ToolCall,
  ToolResult,
  type AgentUsage,
  type Content,
  type NestedToolCallInput,
  type NestedToolCallStatus
} from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  type NestedToolExecutor,
  type ToolExecutionInput,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import {
  codeModeCatalog,
  defaultCodeModeInlineBudget,
  describeCodeModeTool,
  findCodeModeTool,
  renderCodeModeDescription,
  type CodeModeCatalogTool
} from './catalog.ts'
import type {
  CodeModeExecutionResult,
  CodeModeExecutor,
  CodeModeExecutorGlobal,
  CodeModeExecutorTool,
  CodeModeStore
} from './executor.ts'
import {
  codeModeResultSegments,
  codeModeSegmentsContent,
  defaultCodeModeMaxImageBytes,
  defaultCodeModeMaxImages
} from './output.ts'
import { searchCodeModeTools } from './search.ts'
import type { CodeModeStructuredContent } from './store.ts'

/** Default name of the code mode tool. */
export const codeModeToolName = 'codemode'

/** Host-owned limits of one script. */
export type CodeModeLimits = {
  /** Overall deadline including nested calls. Default 120000 (clamped by `deadline`). */
  readonly timeoutMs?: number
  /** VM heap cap. Default 64 MiB. */
  readonly memoryLimitBytes?: number
  /** Nested tool calls per script; further calls reject with an Error. Default 256. */
  readonly maxNestedCalls?: number
  /** Model-visible result characters, cut head and tail with an omission marker. Default 40000. */
  readonly maxOutputChars?: number
  /** Images kept in the result, in order; later images are dropped with a note. Default 8. */
  readonly maxImages?: number
  /** Base64 characters of images kept in the result in total; an image that would exceed it is
   * dropped with a note. Default 4 MiB.
   */
  readonly maxImageBytes?: number
}

export const defaultCodeModeLimits = {
  timeoutMs: 120_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxNestedCalls: 256,
  maxOutputChars: 40_000,
  maxImages: defaultCodeModeMaxImages,
  maxImageBytes: defaultCodeModeMaxImageBytes
} as const satisfies Required<CodeModeLimits>

/** Kept between a host deadline and the script deadline, for result handling. */
export const codeModeDeadlineMarginMs = 5_000

/** A deadline never clamps a script below this timeout. */
export const codeModeMinimumTimeoutMs = 1_000

export type MakeCodeModeToolOptions<Context> = {
  readonly executor: CodeModeExecutor
  /** Default `codemode`. */
  readonly name?: string
  /** Estimated tokens (four characters each) for listing nested tools. Default 3000. */
  readonly inlineBudget?: number
  readonly limits?: CodeModeLimits
  /**
   * Epoch milliseconds by which the tool call must end, for example the remaining function budget
   * of a Workflow step. The script timeout is clamped to it minus 5 s, but never below 1 s.
   */
  readonly deadline?: (context: Context) => number | undefined
  /**
   * The store scripts read with `load(key)`, usually rebuilt from the transcript with
   * `codeModeStoreFromToolResults`. Without it every script starts with an empty store.
   */
  readonly loadStore?: (context: Context) => Effect.Effect<CodeModeStore, ToolError>
  /**
   * Runs before each nested call executes, with the nested call (id `<toolCallId>/<seq>`) and the
   * host context. A failure rejects that call in the script with the message and records it as an
   * `error` without executing it. Host decorators around the `ToolExecutor` (outside
   * `ResolvedToolSet.execute`) never see nested calls: put per-call run-authority checks here or in
   * registration-level wrappers.
   */
  readonly beforeNestedCall?: (input: {
    readonly call: ToolCall
    readonly context: Context
  }) => Effect.Effect<void, string>
}

const CodeModeParams = Schema.Struct({
  code: Schema.String.annotate({
    description:
      'Raw JavaScript: the body of an async function. Top-level await and return work. Not a function declaration and not a module.'
  })
})

type CodeModeParams = typeof CodeModeParams.Type

class CodeModeExecutorRejected extends Data.TaggedError('CodeModeExecutorRejected')<{
  readonly message: string
}> {}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : Predicate.isString(error) ? error : 'unknown error'

const nestedText = (content: Content) =>
  Predicate.isString(content)
    ? content
    : content
        .map(contentPartText)
        .filter(text => text.length > 0)
        .join('\n')

type NestedResolution =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

/** What a nested call resolves to: `structuredContent` for tools with an output schema (when
 * present), text content otherwise; error results reject with their text.
 */
const resolveNestedResult = (tool: CodeModeCatalogTool, result: ToolResult): NestedResolution => {
  const text = nestedText(result.content)

  if (result.isError === true) {
    return { ok: false, message: text.length > 0 ? text : `Tool ${tool.name} failed.` }
  }

  return tool.structured && result.structuredContent !== undefined
    ? { ok: true, value: result.structuredContent }
    : { ok: true, value: text }
}

type CallOutcome = {
  status: NestedToolCallStatus
  durationMs: number
  error?: string
  usage?: AgentUsage
}

type CallRecord = {
  readonly name: string
  readonly args: unknown
  readonly id: string
  outcome?: CallOutcome
}

const recordedOutcome = (exit: Exit.Exit<ToolResult>, durationMs: number): CallOutcome => {
  if (Exit.isFailure(exit)) {
    return Cause.hasInterruptsOnly(exit.cause)
      ? { status: 'cancelled', durationMs }
      : { status: 'error', durationMs, error: 'The tool call failed unexpectedly.' }
  }

  const result = exit.value

  const outcome: CallOutcome =
    result.isError === true
      ? { status: 'error', durationMs, error: nestedText(result.content) }
      : { status: 'ok', durationMs }

  if (result.usage !== undefined) {
    outcome.usage = result.usage
  }

  return outcome
}

/** What `describeNamespace(name)` resolves to. */
type CodeModeNamespaceDescription = {
  readonly name: string
  description?: string
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>
}

const SearchOptions = Schema.Struct({
  limit: Schema.optionalKey(Schema.Finite),
  namespace: Schema.optionalKey(Schema.String)
})

const decodeSearchOptions = Schema.decodeUnknownOption(SearchOptions)

/** `searchTools`, `describeTool`, and `describeNamespace` over every nested tool. */
const discoveryGlobals = (
  catalog: ReadonlyArray<CodeModeCatalogTool>
): ReadonlyArray<CodeModeExecutorGlobal> => [
  {
    name: 'searchTools',
    spread: true,
    execute: args => {
      const [query, options] = Array.isArray(args) ? args : []

      return Promise.resolve(
        searchCodeModeTools(
          catalog,
          Predicate.isString(query) ? query : '',
          Option.getOrElse(decodeSearchOptions(options ?? {}), () => ({}))
        )
      )
    }
  },
  {
    name: 'describeTool',
    execute: name => {
      const tool = Predicate.isString(name) ? findCodeModeTool(catalog, name) : undefined

      return Promise.resolve(tool === undefined ? undefined : describeCodeModeTool(tool))
    }
  },
  {
    name: 'describeNamespace',
    execute: name => {
      const tools = catalog.filter(tool => tool.namespace === name)

      if (!Predicate.isString(name) || tools.length === 0) return Promise.resolve(undefined)

      const description = tools.find(
        tool => tool.namespaceDescription !== undefined
      )?.namespaceDescription

      const namespace: CodeModeNamespaceDescription = {
        name,
        tools: tools.map(tool => ({ name: tool.identifier, description: tool.description }))
      }

      if (description !== undefined) namespace.description = description

      return Promise.resolve(namespace)
    }
  }
]

const hasStoreWrites = (result: CodeModeExecutionResult) =>
  result.storeWrites !== undefined &&
  (Object.keys(result.storeWrites.set).length > 0 || result.storeWrites.delete.length > 0)

const timeoutFor = (limit: number, deadline: number | undefined, now: number) =>
  deadline === undefined
    ? limit
    : Math.max(codeModeMinimumTimeoutMs, Math.min(limit, deadline - now - codeModeDeadlineMarginMs))

/**
 * Waits at most `codeModeDeadlineMarginMs` for an effect (interrupting nested fibers) to finish; it
 * keeps running detached when a nested call does not respond to interruption in time.
 */
const boundedWait = (effect: Effect.Effect<void>) =>
  Effect.forkDetach(effect).pipe(
    Effect.flatMap(fiber =>
      Fiber.await(fiber).pipe(
        Effect.timeoutOption(Duration.millis(codeModeDeadlineMarginMs)),
        Effect.interruptible
      )
    ),
    Effect.asVoid
  )

type RunInput<Context> = {
  readonly options: MakeCodeModeToolOptions<Context>
  readonly limits: Required<CodeModeLimits>
  readonly call: ToolCall
  readonly context: Context
  readonly code: string
  readonly nested: NestedToolExecutor
}

const runScript = <Context>(input: RunInput<Context>): Effect.Effect<ToolResult, ToolError> =>
  Effect.gen(function* () {
    const { call, limits, nested, options } = input
    const store = options.loadStore === undefined ? {} : yield* options.loadStore(input.context)
    const startedAt = yield* Clock.currentTimeMillis
    const timeoutMs = timeoutFor(limits.timeoutMs, options.deadline?.(input.context), startedAt)
    const catalog = codeModeCatalog(nested.tools)

    return yield* Effect.acquireUseRelease(
      Scope.make(),
      scope =>
        Effect.gen(function* () {
          // Nested calls run as fibers of this tool call (same services, interrupted with it).
          const fibers = yield* FiberSet.make<ToolResult>().pipe(Scope.provide(scope))
          const runFork = yield* FiberSet.runtime(fibers)<never>()
          const records: Array<CallRecord> = []

          const callTool =
            (tool: CodeModeCatalogTool): CodeModeExecutorTool['execute'] =>
            (args, { signal }) => {
              if (signal.aborted) {
                return Promise.reject(new Error(`tools.${tool.identifier} was cancelled.`))
              }

              if (records.length >= limits.maxNestedCalls) {
                return Promise.reject(
                  new Error(
                    `Nested call limit reached: a script may make at most ${limits.maxNestedCalls} tool calls. Batch the work or return partial results.`
                  )
                )
              }

              const params = args === undefined ? {} : args

              const record: CallRecord = {
                id: `${call.id}/${records.length + 1}`,
                name: tool.name,
                args: params
              }

              records.push(record)

              const nestedCall = ToolCall.make({ id: record.id, name: tool.name, params })

              const admitted =
                options.beforeNestedCall === undefined
                  ? nested.execute(nestedCall)
                  : options.beforeNestedCall({ call: nestedCall, context: input.context }).pipe(
                      Effect.matchEffect({
                        onFailure: message =>
                          Effect.succeed(
                            ToolResult.make({
                              toolCallId: nestedCall.id,
                              content: message,
                              isError: true
                            })
                          ),
                        onSuccess: () => nested.execute(nestedCall)
                      })
                    )

              const execution = Effect.gen(function* () {
                const started = yield* Clock.currentTimeMillis

                return yield* admitted.pipe(
                  Effect.onExit(exit =>
                    Effect.map(Clock.currentTimeMillis, finished => {
                      record.outcome = recordedOutcome(exit, finished - started)
                    })
                  )
                )
              })

              return new Promise((resolve, reject) => {
                runFork(execution, { signal }).addObserver(exit => {
                  if (Exit.isFailure(exit)) {
                    reject(
                      new Error(
                        Cause.hasInterruptsOnly(exit.cause)
                          ? `tools.${tool.identifier} was cancelled.`
                          : `tools.${tool.identifier} failed unexpectedly.`
                      )
                    )

                    return
                  }

                  const resolution = resolveNestedResult(tool, exit.value)

                  if (resolution.ok) {
                    resolve(resolution.value)
                  } else {
                    reject(new Error(resolution.message))
                  }
                })
              })
            }

          const tools: ReadonlyArray<CodeModeExecutorTool> = catalog.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            execute: callTool(tool)
          }))

          const result = yield* Effect.tryPromise({
            try: signal =>
              options.executor.execute(input.code, {
                tools,
                globals: discoveryGlobals(catalog),
                timeoutMs,
                memoryLimitBytes: limits.memoryLimitBytes,
                store,
                signal
              }),
            catch: error => new CodeModeExecutorRejected({ message: errorMessage(error) })
          }).pipe(
            Effect.catch(error =>
              Effect.succeed<CodeModeExecutionResult>({
                ok: false,
                error: {
                  kind: 'sandbox',
                  message: `The code mode executor failed: ${error.message}`
                },
                output: []
              })
            ),
            // Backstop for executors that miss their own deadline: interrupting aborts the signal.
            Effect.timeoutOption(Duration.millis(timeoutMs + codeModeDeadlineMarginMs)),
            Effect.map(
              Option.getOrElse((): CodeModeExecutionResult => ({
                ok: false,
                error: {
                  kind: 'timeout',
                  message: `Execution timed out after ${timeoutMs} ms (the executor did not stop in time)`
                },
                output: []
              }))
            )
          )

          // Calls still running when the script ended are cancelled and recorded as such.
          yield* boundedWait(FiberSet.clear(fibers))

          const finishedAt = yield* Clock.currentTimeMillis

          const recorded = records.map((record): NestedToolCallInput => ({
            id: record.id,
            name: record.name,
            args: record.args,
            // A call interrupted before it started has no outcome.
            ...(record.outcome ?? { status: 'cancelled' })
          }))

          const recorder = recorded.reduce(recordNestedToolCall, emptyNestedToolCallRecorder)
          const { nestedCalls, usage } = nestedToolCallResultFields(recorder)

          const content = codeModeSegmentsContent(
            codeModeResultSegments({
              result,
              wallTimeMs: finishedAt - startedAt,
              calls: recorded,
              maxChars: limits.maxOutputChars,
              maxImages: limits.maxImages,
              maxImageBytes: limits.maxImageBytes
            })
          )

          const structuredContent: CodeModeStructuredContent = {
            codemode:
              result.ok && result.storeWrites !== undefined && hasStoreWrites(result)
                ? { ok: true, storeWrites: result.storeWrites }
                : { ok: result.ok }
          }

          type ResultFields = {
            toolCallId: string
            content: Content
            isError?: boolean
            structuredContent: CodeModeStructuredContent
            nestedCalls: typeof nestedCalls
            usage?: AgentUsage
          }

          const fields: ResultFields = {
            toolCallId: call.id,
            content,
            structuredContent,
            nestedCalls
          }

          if (!result.ok) {
            fields.isError = true
          }

          if (usage !== undefined) {
            fields.usage = usage
          }

          return ToolResult.make(fields)
        }),
      (scope, exit) => boundedWait(Scope.close(scope, exit))
    )
  })

/**
 * The code mode tool: one registration (default name `codemode`, input `{ code }`) whose scripts
 * call the other code-mode-callable tools of the same `resolveTools` resolution. Nested calls run
 * through the resolved execute path with the same host context (input decoding, enablement,
 * registration wrappers), get ids `<toolCallId>/<seq>`, and are recorded on the result's
 * `nestedCalls`. The resolved description lists the callable tools (see
 * `renderCodeModeDescription`).
 *
 * Access is `write`: scripts can call any write tool the resolution exposes to code mode; each
 * nested call keeps its own access metadata and host wrappers.
 */
export const makeCodeModeTool = <Context>(
  options: MakeCodeModeToolOptions<Context>
): ToolRegistration<Context> => {
  const name = options.name ?? codeModeToolName
  const limits: Required<CodeModeLimits> = { ...defaultCodeModeLimits, ...options.limits }
  const inlineBudget = options.inlineBudget ?? defaultCodeModeInlineBudget
  const store = options.loadStore !== undefined

  return makeTool<Context, typeof CodeModeParams>({
    name,
    description: renderCodeModeDescription({ tools: [], inlineBudget, store }),
    parameters: CodeModeParams,
    access: 'write',
    nestedToolAccess: true,
    describe: ({ tools }) => renderCodeModeDescription({ tools, inlineBudget, store }),
    execute: ({
      call,
      context,
      params,
      nested
    }: ToolExecutionInput<Context> & { readonly params: CodeModeParams }) =>
      nested === undefined
        ? Effect.fail(
            new ToolError({
              tool: name,
              cause: 'unavailable',
              message: `${name} requires nested tool access; resolve it with resolveTools.`
            })
          )
        : runScript({ options, limits, call, context, code: params.code, nested })
  })
}
