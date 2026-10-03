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
  makeNestedToolCallRecorder,
  nestedToolCallMaxArgsBytes,
  nestedToolCallMaxErrorChars,
  nestedToolCallMaxTotalArgsBytes,
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
  type ToolLedgerAbandonedInput,
  type ToolLedgerEntry,
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
  boundCodeModeSegments,
  codeModeResultSegments,
  codeModeSegmentsContent,
  defaultCodeModeMaxImageBytes,
  defaultCodeModeMaxImages
} from './output.ts'
import { searchCodeModeTools } from './search.ts'
import type {
  CodeModeInterruptedCall,
  CodeModeInterruptedCalls,
  CodeModeInterruptedCallStatus,
  CodeModeStructuredContent
} from './store.ts'

/** Default name of the code mode tool. */
export const codeModeToolName = 'codemode'

/** Host-owned limits of one script. */
export type CodeModeLimits = {
  /** Overall deadline including nested calls. Default 120000 (clamped by `deadline`). */
  readonly timeoutMs?: number
  /** VM heap cap. Default 64 MiB. */
  readonly memoryLimitBytes?: number
  /** Nested tool calls per script; further calls reject with an Error. Default 256. The
   * `nestedCalls` record keeps up to this many calls (argument byte budgets still apply).
   */
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
  /**
   * Runs after each nested call that `beforeNestedCall` admitted, with its outcome: `success` (a
   * result without `isError`), `failure` (an error result or an unexpected failure), or
   * `interrupted` (cancelled, for example still running when the script ended). `durationMs`
   * covers the execution; `result` is present when the call produced one. Calls rejected by
   * `beforeNestedCall` or the call limit never ran and are not reported. The script waits for the
   * hook before it sees the call settle.
   */
  readonly afterNestedCall?: (input: CodeModeAfterNestedCallInput<Context>) => Effect.Effect<void>
}

/** Outcome of a nested call for `afterNestedCall`. */
export type CodeModeNestedCallOutcome = 'success' | 'failure' | 'interrupted'

export type CodeModeAfterNestedCallInput<Context> = {
  readonly call: ToolCall
  readonly outcome: CodeModeNestedCallOutcome
  readonly durationMs: number
  readonly context: Context
  readonly result?: ToolResult
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
 * present), text content otherwise; error results reject with their text. A tool that declares an
 * output schema but returns no `structuredContent` resolves to its text: that is a tool bug, kept
 * readable rather than turned into a failure.
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

const hookOutcome = (exit: Exit.Exit<ToolResult>): CodeModeNestedCallOutcome =>
  Exit.isSuccess(exit)
    ? exit.value.isError === true
      ? 'failure'
      : 'success'
    : Cause.hasInterruptsOnly(exit.cause)
      ? 'interrupted'
      : 'failure'

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
                return Promise.reject(new Error(`${tool.callLabel} was cancelled.`))
              }

              if (records.length >= limits.maxNestedCalls) {
                return Promise.reject(
                  new Error(
                    `${tool.callLabel}: Nested call limit reached: a script may make at most ${limits.maxNestedCalls} tool calls. Batch the work or return partial results.`
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
              const afterNestedCall = options.afterNestedCall

              const run =
                afterNestedCall === undefined
                  ? nested.execute(nestedCall)
                  : Effect.gen(function* () {
                      const started = yield* Clock.currentTimeMillis

                      return yield* nested.execute(nestedCall).pipe(
                        Effect.onExit(exit =>
                          Effect.flatMap(Clock.currentTimeMillis, finished =>
                            afterNestedCall(
                              Exit.isSuccess(exit)
                                ? {
                                    call: nestedCall,
                                    outcome: hookOutcome(exit),
                                    durationMs: finished - started,
                                    context: input.context,
                                    result: exit.value
                                  }
                                : {
                                    call: nestedCall,
                                    outcome: hookOutcome(exit),
                                    durationMs: finished - started,
                                    context: input.context
                                  }
                            )
                          )
                        )
                      )
                    })

              const admitted =
                options.beforeNestedCall === undefined
                  ? run
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
                        onSuccess: () => run
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
                          ? `${tool.callLabel} was cancelled.`
                          : `${tool.callLabel} failed unexpectedly.`
                      )
                    )

                    return
                  }

                  const resolution = resolveNestedResult(tool, exit.value)

                  if (resolution.ok) {
                    resolve(resolution.value)
                  } else {
                    // The script sees which call failed; the nested-call record keeps the raw text.
                    reject(new Error(`${tool.callLabel}: ${resolution.message}`))
                  }
                })
              })
            }

          const tools: ReadonlyArray<CodeModeExecutorTool> = catalog.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            callLabel: tool.callLabel,
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

          const recorder = recorded.reduce(
            recordNestedToolCall,
            makeNestedToolCallRecorder({ maxCalls: limits.maxNestedCalls })
          )

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

const argsPreviewChars = 200

const truncateCharacters = (text: string, maxCharacters: number) => {
  const characters = Array.from(text)

  return characters.length <= maxCharacters
    ? text
    : `${characters.slice(0, maxCharacters - 1).join('')}…`
}

const textEncoder = new TextEncoder()

const utf8Bytes = (text: string) => textEncoder.encode(text).length

// Cuts on code point boundaries so surrogate pairs and multi-byte characters stay whole.
const truncateUtf8 = (text: string, maxBytes: number) => {
  if (utf8Bytes(text) <= maxBytes) return text

  const budget = maxBytes - utf8Bytes('…')

  if (budget < 0) return ''

  let bytes = 0
  let kept = ''

  for (const character of text) {
    const size = utf8Bytes(character)

    if (bytes + size > budget) break

    kept += character
    bytes += size
  }

  return `${kept}…`
}

const interruptedCallStatus = (entry: ToolLedgerEntry): CodeModeInterruptedCallStatus => {
  const outcome = entry.outcome

  if (outcome === undefined) return 'unknown'

  if (Predicate.isTagged(outcome, 'Failed')) return 'failed'

  return outcome.result.isError === true ? 'failed' : 'applied'
}

const nestedEntryState = (entry: ToolLedgerEntry) => {
  const outcome = entry.outcome

  if (outcome === undefined) {
    return 'unknown: it started but never recorded a result, so it may have been applied'
  }

  if (Predicate.isTagged(outcome, 'Failed'))
    return `completed with an error: ${truncateCharacters(outcome.error.message, nestedToolCallMaxErrorChars)}`

  return outcome.result.isError === true ? 'completed with an error result' : 'applied'
}

/** The bounded, wire-safe `interruptedCalls` of an abandoned execution's nested ledger entries:
 * the `nestedCalls` record bounds (`maxCalls`, 8 KiB of arguments per call, 32 KiB in total).
 */
const interruptedCalls = (
  nested: ReadonlyArray<ToolLedgerEntry>,
  maxCalls: number
): CodeModeInterruptedCalls => {
  const counts = { applied: 0, failed: 0, unknown: 0 }
  const calls: Array<CodeModeInterruptedCall> = []
  let argsBytes = 0
  let complete = true

  for (const entry of nested) {
    const status = interruptedCallStatus(entry)

    counts[status]++

    if (calls.length >= maxCalls) {
      complete = false
      continue
    }

    const limit = Math.max(
      0,
      Math.min(nestedToolCallMaxArgsBytes, nestedToolCallMaxTotalArgsBytes - argsBytes)
    )

    const args = truncateUtf8(entry.args, limit)

    if (args !== entry.args) complete = false

    argsBytes += utf8Bytes(args)
    calls.push({ key: entry.key, toolName: entry.toolName, args, status })
  }

  return { calls, complete, counts }
}

/**
 * The result of a code mode call whose earlier execution was abandoned (claimed, lease expired,
 * no result recorded). The script never runs again: the result lists that execution's ledgered
 * nested calls as applied, failed, or unknown, and says they were not undone. The text is bounded
 * by `maxOutputChars`; `structuredContent.codemode.interruptedCalls` carries the same entries for
 * hosts, bounded like `nestedCalls`.
 */
const abandonedScriptResult =
  (limits: Required<CodeModeLimits>) =>
  ({ call, nested }: ToolLedgerAbandonedInput): ToolResult => {
    const maxChars = limits.maxOutputChars

    const listing =
      nested.length === 0
        ? 'No ledgered nested tool calls were recorded for that execution.'
        : [
            `Ledgered nested tool calls of that execution (they were not undone):`,
            ...nested.map(
              entry =>
                `- ${entry.key} ${entry.toolName} ${truncateCharacters(entry.args, argsPreviewChars)}: ${nestedEntryState(entry)}`
            )
          ].join('\n')

    const text = [
      `Script interrupted: an earlier execution of this ${call.name} call (${call.id}) started but never recorded a result. The script was not run again.`,
      listing,
      'Read-only calls are not ledgered and are not listed. Verify the state these calls affect before repeating any work.'
    ].join('\n\n')

    const structuredContent: CodeModeStructuredContent = {
      codemode: {
        ok: false,
        interrupted: true,
        interruptedCalls: interruptedCalls(nested, limits.maxNestedCalls)
      }
    }

    return ToolResult.make({
      toolCallId: call.id,
      content: codeModeSegmentsContent(boundCodeModeSegments([{ type: 'text', text }], maxChars)),
      isError: true,
      structuredContent
    })
  }

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
 *
 * With a tool ledger (`resolveTools(..., { ledger })`) the code mode call itself is ledgered, so a
 * re-executed call never runs its script again: a completed call returns its stored result, an
 * in-flight one is awaited, and an abandoned one returns an interrupted result listing its
 * ledgered nested calls. Nested write calls are ledgered under `<toolCallId>/<seq>`.
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
    abandonedResult: abandonedScriptResult(limits),
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
