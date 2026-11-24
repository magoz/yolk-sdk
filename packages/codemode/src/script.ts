import {
  Array as Arr,
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
  Result,
  Scope
} from 'effect'
import * as Schema from 'effect/Schema'
import {
  makeNestedToolCallRecorder,
  mergeInputRequiredRefs,
  nestedToolCallResultFields,
  recordNestedToolCall,
  toolInputRequired,
  ToolCall,
  ToolResult,
  type AgentUsage,
  type Content,
  type NestedToolCallInput,
  type NestedToolCallStatus,
  type NestedToolCalls,
  type ToolInputRequiredRef
} from '@yolk-sdk/agent/protocol'
import { toCodemodeIdentifier } from '@earendil-works/pi-codemode/declarations'
import type {
  NestedTool,
  NestedToolExecutor,
  StagedCallReceipt,
  ToolAccess,
  ToolPlanBuilder,
  ToolPlanStageError
} from '@yolk-sdk/agent/tools'
import {
  codeModeCatalog,
  codeModeStageOnlyCatalog,
  describeCodeModeTool,
  findCodeModeTool,
  type CodeModeCatalogTool
} from './catalog.ts'
import type {
  CodeModeError,
  CodeModeExecutionResult,
  CodeModeExecutor,
  CodeModeExecutorGlobal,
  CodeModeExecutorTool,
  CodeModeOutputItem,
  CodeModeStore,
  CodeModeStoreWrites
} from './executor.ts'
import { defaultCodeModeMaxImageBytes, defaultCodeModeMaxImages } from './output.ts'
import { searchCodeModeTools } from './search.ts'
import type { CodeModeStagedPlan } from './store.ts'

/** Host-owned limits of one script. */
export type CodeModeLimits = {
  /** Overall deadline including nested calls. Default 120000 (clamped by `deadline`). */
  readonly timeoutMs?: number
  /** VM heap cap. Default 64 MiB. */
  readonly memoryLimitBytes?: number
  /** Nested tool calls per script; further calls reject with an Error. Default 256. The
   * `nestedCalls` record keeps up to this many calls, at most `nestedToolCallMaxRecordedCalls`
   * (4096) whatever the limit (argument byte budgets still apply).
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

export type CodeModeStagingOptions = {
  /** Staged calls per script; `stage` rejects past it. At most the resolution's `maxCalls`. */
  readonly maxCalls?: number
}

/** Outcome of a nested call for `afterNestedCall`. */
export type CodeModeNestedCallOutcome = 'success' | 'failure' | 'interrupted'

/** What `beforeNestedCall` sees of a nested call, before it runs. */
export type CodeModeBeforeNestedCallInput = {
  /** The nested call (id `<parentCallId>/<seq>`), arguments as the script sent them. */
  readonly call: ToolCall
  /** The called tool as the resolution lists it (`NestedToolExecutor.tools`). */
  readonly tool: NestedTool
  /**
   * The call's effective access (`NestedToolExecutor.access`, from `toolCallAccess`): `read` for
   * a read-only call of a non-`read` tool, `undefined` for a tool the resolution would refuse.
   */
  readonly access: ToolAccess | undefined
}

/** What `afterNestedCall` sees of a nested call `beforeNestedCall` admitted, once it settled. */
export type CodeModeNestedCallSettledInput = {
  readonly call: ToolCall
  readonly outcome: CodeModeNestedCallOutcome
  readonly durationMs: number
  readonly result?: ToolResult
}

/**
 * A `beforeNestedCall` refusal with a machine-readable `code`. The script's rejection carries the
 * code as `error.code` and the message as its text; the call's `CodeModeScriptCall.refusal` keeps
 * both. A plain string refusal has a message only.
 */
export class CodeModeNestedCallRefused extends Data.TaggedError('CodeModeNestedCallRefused')<{
  readonly code: string
  readonly message: string
}> {}

/** Why `beforeNestedCall` refused a call; it never ran. */
export type CodeModeNestedCallRefusal = {
  readonly message: string
  /** Present when the hook refused with a `CodeModeNestedCallRefused`. */
  readonly code?: string
}

/** Admits a nested call, or refuses it (it never runs) with a message or a coded refusal. */
export type CodeModeBeforeNestedCall<Input = CodeModeBeforeNestedCallInput> = (
  input: Input
) => Effect.Effect<void, string | CodeModeNestedCallRefused>

/**
 * One nested call a script made, in order. `status`, `error`, `durationMs` and `usage` as on the
 * `nestedCalls` record, unbounded (every call, full arguments); `refusal` is set when
 * `beforeNestedCall` refused it, whether or not the script caught the rejection.
 */
export type CodeModeScriptCall = NestedToolCallInput & {
  readonly refusal?: CodeModeNestedCallRefusal
}

/** The staged calls of a script that staged at least one (ADR 0005). */
export type CodeModeScriptStaged =
  /** The script succeeded and its plan was saved; nothing of it ran. */
  | { readonly _tag: 'Saved'; readonly count: number; readonly plan: CodeModeStagedPlan }
  /** The script failed, so its staged calls were discarded. */
  | { readonly _tag: 'Discarded'; readonly count: number }
  /** The script succeeded but its plan could not be saved; nothing was applied. */
  | { readonly _tag: 'SaveFailed'; readonly count: number; readonly message: string }

export const CodeModeScriptStaged = Data.taggedEnum<CodeModeScriptStaged>()

type CodeModeScriptRun = {
  /** What the script printed (text and images), in order, unbounded. Kept for failed scripts. */
  readonly output: ReadonlyArray<CodeModeOutputItem>
  /** Every nested call the script made, refused ones included; calls past `maxNestedCalls`
   * rejected before they got an id and are not listed. */
  readonly calls: ReadonlyArray<CodeModeScriptCall>
  /** The bounded record of `calls` (`ToolResult.nestedCalls` of the code mode tool). */
  readonly nestedCalls: NestedToolCalls
  /** Token usage the nested calls reported, summed. */
  readonly usage?: AgentUsage
  /** `usage` under-counts a nested call (`ToolResult.usageIncomplete`). */
  readonly usageIncomplete?: true
  /** Nested calls that paused for input (ADR 0014), merged per review tool. */
  readonly inputRequired: ReadonlyArray<ToolInputRequiredRef>
  /** Present when the script staged calls (only when `nested` offers staging). */
  readonly staged?: CodeModeScriptStaged
  /** The script's timeout after the deadline clamp. */
  readonly timeoutMs: number
  readonly wallTimeMs: number
}

/**
 * What one script came to. `ok: true`: it returned (`value`, its JSON return value, absent when it
 * returned nothing) with its `store()` writes; `ok: false`: it threw, failed to parse, timed out,
 * was aborted, or the engine failed (`error`). A plan that could not be saved is reported in
 * `staged`, not here.
 */
export type CodeModeScriptResult = CodeModeScriptRun &
  (
    | {
        readonly ok: true
        readonly value?: unknown
        /** Present only when the script changed the store. */
        readonly storeWrites?: CodeModeStoreWrites
      }
    | { readonly ok: false; readonly error: CodeModeError }
  )

export type RunCodeModeScriptOptions = {
  readonly executor: CodeModeExecutor
  /** The script: the body of an async function (top-level `await` and `return`). */
  readonly code: string
  /**
   * The tools the script calls: a nested-access registration's `nested`, or
   * `ResolvedToolSet.nestedExecutor({ parentCallId })` for a script the host runs itself.
   */
  readonly nested: NestedToolExecutor
  /**
   * The id `nested` is bound to: nested calls get ids `<parentCallId>/<seq>` (1-based), their
   * ledger keys under parent key `parentCallId`.
   */
  readonly parentCallId: string
  readonly limits?: CodeModeLimits
  /**
   * Epoch milliseconds by which the run must end. The script timeout is clamped to it minus 5 s,
   * but never below 1 s.
   */
  readonly deadline?: number
  /** What the script reads with `load(key)`. Default empty. */
  readonly store?: CodeModeStore
  /**
   * Runs before each nested call, after its effective access is known. A failure refuses the call:
   * the script's call rejects with the message (and `error.code` for a `CodeModeNestedCallRefused`)
   * and the call is recorded as an `error` with its `refusal`, without executing. See
   * `readOnlyNestedCallGate`.
   */
  readonly beforeNestedCall?: CodeModeBeforeNestedCall
  /**
   * Runs after each nested call `beforeNestedCall` admitted, with its outcome; the script sees the
   * call settle after it. A failing hook (a failure, a defect, or a synchronous throw) is logged and
   * never changes the call's result.
   */
  readonly afterNestedCall?: (input: CodeModeNestedCallSettledInput) => Effect.Effect<void>
  /**
   * Staged tool plans (ADR 0005), when `nested.staging` offers them: scripts get
   * `stage(name, args)`. `false` turns it off; `maxCalls` may only lower the resolution's cap.
   */
  readonly staging?: CodeModeStagingOptions | false
}

class CodeModeExecutorRejected extends Data.TaggedError('CodeModeExecutorRejected')<{
  readonly message: string
}> {}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : Predicate.isString(error) ? error : 'unknown error'

// The text a script sees of a result: its text parts only. File, image, document and audio parts
// (and the labels providers render for them) never enter scripts (ADR 0013).
const nestedText = (content: Content) =>
  Predicate.isString(content)
    ? content
    : content
        .flatMap(part => (Predicate.isTagged(part, 'Text') ? [part.text] : []))
        .filter(text => text.length > 0)
        .join('\n')

type NestedResolution =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string; readonly code?: string }

// The `code` of an error result: a model-visible error's (`ModelVisibleToolError.code`) or any
// structured error with a string `code` (a connector's `ProviderFailure`).
const decodeErrorCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

const errorCode = (result: ToolResult) =>
  Option.getOrUndefined(
    Option.map(decodeErrorCode(result.structuredContent), envelope => envelope.code)
  )

/** A typed tool's successful result without its value: the script never falls back to text. */
const isInvalidTypedResult = (tool: CodeModeCatalogTool, result: ToolResult) =>
  tool.structured && result.isError !== true && result.structuredContent === undefined

/**
 * What a nested call resolves to (ADR 0013). A typed tool (one with an output schema) resolves to
 * its value as declared, file fields as `FileRef` or `FileUnavailable`; a typed result without a
 * value rejects ("returned an invalid result"). An untyped tool resolves to its text parts joined
 * with newlines. Error results reject with their text and the `code` of their structured error
 * (a model-visible error's code, a connector failure's code). Files never reach scripts as labels.
 */
const resolveNestedResult = (tool: CodeModeCatalogTool, result: ToolResult): NestedResolution => {
  if (result.isError === true) {
    const text = nestedText(result.content)
    const message = text.length > 0 ? text : `Tool ${tool.name} failed.`
    const code = errorCode(result)

    return code === undefined ? { ok: false, message } : { ok: false, message, code }
  }

  if (!tool.structured) return { ok: true, value: nestedText(result.content) }

  return result.structuredContent === undefined
    ? { ok: false, message: 'returned an invalid result' }
    : { ok: true, value: result.structuredContent }
}

/** The script-visible rejection of a nested call, with the tool's error `code` when it has one. */
const nestedCallError = (label: string, resolution: { message: string; code?: string }) => {
  const error = new Error(`${label}: ${resolution.message}`)

  return resolution.code === undefined ? error : Object.assign(error, { code: resolution.code })
}

type CallOutcome = {
  status: NestedToolCallStatus
  durationMs: number
  error?: string
  usage?: AgentUsage
  usageIncomplete?: true
}

type RecordedCallFields = {
  id: string
  name: string
  args: unknown
  status: NestedToolCallStatus
  access?: ToolAccess
  durationMs?: number
  error?: string
  usage?: AgentUsage
  usageIncomplete?: true
}

type CallRecord = {
  readonly name: string
  readonly args: unknown
  readonly id: string
  access?: ToolAccess
  outcome?: CallOutcome
  refusal?: CodeModeNestedCallRefusal
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

  if (result.usageIncomplete === true) {
    outcome.usageIncomplete = true
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

const refusalOf = (error: string | CodeModeNestedCallRefused): CodeModeNestedCallRefusal =>
  Predicate.isString(error) ? { message: error } : { message: error.message, code: error.code }

/** The error result a refused call answers with; its `code` reaches the script as `error.code`. */
const refusedResult = (call: ToolCall, refusal: CodeModeNestedCallRefusal) =>
  ToolResult.make(
    refusal.code === undefined
      ? { toolCallId: call.id, content: refusal.message, isError: true }
      : {
          toolCallId: call.id,
          content: refusal.message,
          isError: true,
          structuredContent: { code: refusal.code }
        }
  )

/** What `describeNamespace(name)` resolves to. */
type CodeModeNamespaceDescription = {
  readonly name: string
  description?: string
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly stageOnly?: true
  }>
}

const SearchOptions = Schema.Struct({
  limit: Schema.optionalKey(Schema.Finite),
  namespace: Schema.optionalKey(Schema.String)
})

const decodeSearchOptions = Schema.decodeUnknownOption(SearchOptions)

/** `searchTools`, `describeTool`, and `describeNamespace` over every nested tool and, while the
 * script may stage, every stageable tool. */
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
        tools: tools.map(tool =>
          tool.exposure === 'stage'
            ? { name: tool.name, description: tool.description, stageOnly: true }
            : { name: tool.identifier, description: tool.description }
        )
      }

      if (description !== undefined) namespace.description = description

      return Promise.resolve(namespace)
    }
  }
]

type StageFork = (
  effect: Effect.Effect<StagedCallReceipt, ToolPlanStageError>,
  options: { readonly signal: AbortSignal }
) => Fiber.Fiber<StagedCallReceipt, ToolPlanStageError>

/**
 * `stage(name, args)`: records one call into the script's plan (never runs it). `name` is the raw
 * tool name or its catalog identifier (what `searchTools` returns for callable tools).
 */
const stageGlobal = (
  plan: ToolPlanBuilder,
  fork: StageFork,
  stageable: ReadonlyArray<NestedTool>
): CodeModeExecutorGlobal => ({
  name: 'stage',
  spread: true,
  signature: '(name: string, args: object): Promise<{ staged: true; key: string; index: number }>',
  description:
    'Record a call of a stageable tool into this script’s plan for a person to review; it does not run.',
  execute: (args, { signal }) => {
    const [name, params] = Array.isArray(args) ? args : []

    if (signal.aborted) return Promise.reject(new Error('stage was cancelled.'))

    if (!Predicate.isString(name))
      return Promise.reject(new Error('stage: the first argument must be a tool name.'))

    const toolName =
      stageable.find(({ def }) => def.name === name)?.def.name ??
      stageable.find(({ def }) => toCodemodeIdentifier(def.name) === name)?.def.name ??
      name

    return new Promise((resolve, reject) => {
      fork(plan.stage({ name: toolName, params: params === undefined ? {} : params }), {
        signal
      }).addObserver(exit => {
        if (Exit.isSuccess(exit)) {
          resolve(exit.value)

          return
        }

        const error = Cause.findErrorOption(exit.cause)

        reject(
          new Error(
            Option.isSome(error)
              ? `stage: ${error.value.message}`
              : Cause.hasInterruptsOnly(exit.cause)
                ? 'stage was cancelled.'
                : 'stage failed unexpectedly.'
          )
        )
      })
    })
  }
})

/** A direct call of a stageable tool rejects with a hint to stage it (ADR 0007). */
const stageOnlyRejections = (stageOnly: ReadonlyArray<CodeModeCatalogTool>) =>
  stageOnly.flatMap(tool => {
    const message = `${tool.name} is approval-gated: record it with stage(${JSON.stringify(tool.name)}, args) instead of calling it.`

    return tool.identifier === tool.name
      ? [{ key: tool.name, message }]
      : [
          { key: tool.identifier, message },
          { key: tool.name, message }
        ]
  })

const hasStoreWrites = (writes: CodeModeStoreWrites | undefined): writes is CodeModeStoreWrites =>
  writes !== undefined && (Object.keys(writes.set).length > 0 || writes.delete.length > 0)

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

const missingError: CodeModeError = {
  kind: 'sandbox',
  message: 'The script failed without an error.'
}

/**
 * Runs one code mode script outside a model turn, over `nested` (a nested-access registration's,
 * or `ResolvedToolSet.nestedExecutor` for a host-run script), and returns what it did as data:
 * `makeCodeModeTool` runs every script through it. Nested calls take the resolved execute path
 * (input decoding, registration wrappers, the ledger), get ids `<parentCallId>/<seq>`, pass
 * `beforeNestedCall` and `afterNestedCall`, and run as fibers of this effect: interrupting it
 * aborts the script and cancels running calls through their signal. Limits, the deadline clamp
 * and the executor backstop (`timeoutMs` + 5 s) are the tool's. Never fails: script errors,
 * timeouts and engine failures are `ok: false`.
 */
export const runCodeModeScript = (
  options: RunCodeModeScriptOptions
): Effect.Effect<CodeModeScriptResult> =>
  Effect.gen(function* () {
    const { nested, parentCallId } = options
    const limits: Required<CodeModeLimits> = { ...defaultCodeModeLimits, ...options.limits }
    const store = options.store ?? {}
    const startedAt = yield* Clock.currentTimeMillis
    const timeoutMs = timeoutFor(limits.timeoutMs, options.deadline, startedAt)
    const catalog = Arr.zip(codeModeCatalog(nested.tools), nested.tools)

    return yield* Effect.acquireUseRelease(
      Scope.make(),
      scope =>
        Effect.gen(function* () {
          // Nested calls run as fibers of this run (same services, interrupted with it).
          const fibers = yield* FiberSet.make<ToolResult>().pipe(Scope.provide(scope))
          const runFork = yield* FiberSet.runtime(fibers)<never>()
          const records: Array<CallRecord> = []
          // Nested calls that paused for input (ADR 0014), reported even when the script caught them.
          const paused: Array<ToolInputRequiredRef> = []

          // Staged tool plans: only when the resolution offers staging and the host keeps it on.
          const stagingOptions = options.staging === false ? undefined : options.staging
          const staging = options.staging === false ? undefined : nested.staging
          const maxStagedCalls = stagingOptions?.maxCalls

          const plan =
            staging === undefined
              ? undefined
              : staging.begin(
                  maxStagedCalls === undefined ? undefined : { maxCalls: maxStagedCalls }
                )

          const stageFibers = yield* FiberSet.make<StagedCallReceipt, ToolPlanStageError>().pipe(
            Scope.provide(scope)
          )

          const stageFork = yield* FiberSet.runtime(stageFibers)<never>()

          const callTool =
            (tool: CodeModeCatalogTool, nestedTool: NestedTool): CodeModeExecutorTool['execute'] =>
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
                id: `${parentCallId}/${records.length + 1}`,
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

                      // Host observability never changes the call: a hook failure, defects and
                      // synchronous throws included, is only logged.
                      const afterNestedCallSafely = (hookInput: CodeModeNestedCallSettledInput) =>
                        Effect.suspend(() => afterNestedCall(hookInput)).pipe(
                          Effect.exit,
                          Effect.flatMap(hookExit =>
                            Exit.isSuccess(hookExit)
                              ? Effect.void
                              : Effect.logWarning(
                                  `Code mode afterNestedCall failed for ${nestedCall.id}; ignored: ${Cause.pretty(hookExit.cause)}`
                                )
                          )
                        )

                      return yield* nested.execute(nestedCall).pipe(
                        Effect.onExit(exit =>
                          Effect.flatMap(Clock.currentTimeMillis, finished =>
                            afterNestedCallSafely(
                              Exit.isSuccess(exit)
                                ? {
                                    call: nestedCall,
                                    outcome: hookOutcome(exit),
                                    durationMs: finished - started,
                                    result: exit.value
                                  }
                                : {
                                    call: nestedCall,
                                    outcome: hookOutcome(exit),
                                    durationMs: finished - started
                                  }
                            )
                          )
                        )
                      )
                    })

              // The plan's ordering guardrail: once a script stages, only read tools run.
              const guarded =
                plan === undefined
                  ? run
                  : plan.admit(nestedCall).pipe(
                      Effect.matchEffect({
                        onFailure: error =>
                          Effect.succeed(
                            ToolResult.make({
                              toolCallId: nestedCall.id,
                              content: error.message,
                              isError: true
                            })
                          ),
                        onSuccess: () => run
                      })
                    )

              const admitted = (access: ToolAccess | undefined) => {
                const beforeNestedCall = options.beforeNestedCall

                return beforeNestedCall === undefined
                  ? guarded
                  : Effect.suspend(() =>
                      beforeNestedCall({ call: nestedCall, tool: nestedTool, access })
                    ).pipe(
                      Effect.matchEffect({
                        onFailure: error => {
                          const refusal = refusalOf(error)

                          record.refusal = refusal

                          return Effect.succeed(refusedResult(nestedCall, refusal))
                        },
                        onSuccess: () => guarded
                      })
                    )
              }

              const execution = Effect.gen(function* () {
                const access = yield* nested.access(nestedCall)

                if (access !== undefined) record.access = access

                const started = yield* Clock.currentTimeMillis

                return yield* admitted(access).pipe(
                  Effect.onExit(exit =>
                    Effect.map(Clock.currentTimeMillis, finished => {
                      record.outcome = recordedOutcome(exit, finished - started)
                    })
                  ),
                  Effect.tap(result =>
                    Effect.sync(() => {
                      const ref = toolInputRequired(result)

                      if (Option.isSome(ref)) paused.push(ref.value)
                    })
                  ),
                  Effect.tap(result =>
                    isInvalidTypedResult(tool, result)
                      ? Effect.logWarning(
                          `Code mode: ${tool.name} declares an output schema but returned no value (call ${nestedCall.id}).`
                        )
                      : Effect.void
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
                    reject(nestedCallError(tool.callLabel, resolution))
                  }
                })
              })
            }

          const tools: ReadonlyArray<CodeModeExecutorTool> = catalog.map(([tool, nestedTool]) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            callLabel: tool.callLabel,
            execute: callTool(tool, nestedTool)
          }))

          const catalogTools = catalog.map(([tool]) => tool)

          const stageOnly =
            plan === undefined || staging === undefined
              ? []
              : codeModeStageOnlyCatalog(staging.tools)

          const result = yield* Effect.tryPromise({
            try: signal =>
              options.executor.execute(options.code, {
                tools,
                globals:
                  plan === undefined || staging === undefined
                    ? discoveryGlobals(catalogTools)
                    : [
                        ...discoveryGlobals([...catalogTools, ...stageOnly]),
                        stageGlobal(plan, stageFork, staging.tools)
                      ],
                unbound: stageOnlyRejections(stageOnly),
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
          yield* boundedWait(FiberSet.clear(stageFibers))

          const finishedAt = yield* Clock.currentTimeMillis

          // A successful script's staged calls are saved once as a plan; a failed script's are
          // discarded (a partial plan is never offered for review). Nothing staged ever ran.
          const stagedCount = plan === undefined ? 0 : (yield* plan.staged).length

          const saved =
            plan === undefined || stagedCount === 0 || !result.ok
              ? undefined
              : yield* plan.finish.pipe(Effect.result)

          const staged: CodeModeScriptStaged | undefined =
            staging === undefined || stagedCount === 0
              ? undefined
              : !result.ok
                ? CodeModeScriptStaged.Discarded({ count: stagedCount })
                : saved === undefined
                  ? undefined
                  : Result.isFailure(saved)
                    ? CodeModeScriptStaged.SaveFailed({
                        count: stagedCount,
                        message: saved.failure.message
                      })
                    : saved.success === undefined
                      ? undefined
                      : CodeModeScriptStaged.Saved({
                          count: stagedCount,
                          plan: {
                            id: saved.success.id,
                            digest: saved.success.digest,
                            count: saved.success.calls.length,
                            reviewToolName: staging.reviewToolName
                          }
                        })

          const recorded = records.map((record): NestedToolCallInput => {
            const fields: RecordedCallFields = {
              id: record.id,
              name: record.name,
              args: record.args,
              // A call interrupted before it started has no outcome.
              ...(record.outcome ?? { status: 'cancelled' })
            }

            if (record.access !== undefined) fields.access = record.access

            return fields
          })

          const calls = Arr.zipWith(recorded, records, (call, record): CodeModeScriptCall =>
            record.refusal === undefined ? call : { ...call, refusal: record.refusal }
          )

          const recorder = recorded.reduce(
            recordNestedToolCall,
            makeNestedToolCallRecorder({ maxCalls: limits.maxNestedCalls })
          )

          const { nestedCalls, usage, usageIncomplete } = nestedToolCallResultFields(recorder)

          type RunFields = {
            -readonly [Key in keyof CodeModeScriptRun]: CodeModeScriptRun[Key]
          }

          const run: RunFields = {
            output: result.output,
            calls,
            nestedCalls,
            inputRequired: mergeInputRequiredRefs(paused),
            timeoutMs,
            wallTimeMs: finishedAt - startedAt
          }

          if (usage !== undefined) run.usage = usage

          if (usageIncomplete !== undefined) run.usageIncomplete = usageIncomplete

          if (staged !== undefined) run.staged = staged

          if (!result.ok) {
            const failed: CodeModeScriptResult = {
              ...run,
              ok: false,
              error: result.error ?? missingError
            }

            return failed
          }

          type SucceededFields = RunFields & {
            ok: true
            value?: unknown
            storeWrites?: CodeModeStoreWrites
          }

          const succeeded: SucceededFields = { ...run, ok: true }

          if (result.value !== undefined) succeeded.value = result.value

          if (hasStoreWrites(result.storeWrites)) succeeded.storeWrites = result.storeWrites

          return succeeded
        }),
      (scope, exit) => boundedWait(Scope.close(scope, exit))
    )
  })
