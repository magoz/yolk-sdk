import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  boundNestedToolCallArgs,
  inputRequiredNotice,
  mergeInputRequiredRefs,
  toolInputRequired,
  nestedToolCallMaxErrorChars,
  nestedToolCallRecordLimit,
  truncateCodePoints,
  ToolResult,
  type AgentUsage,
  type Content,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  stagedToolPlanNotice,
  type NestedToolInstructor,
  type ToolExecutionInput,
  type ToolLedgerAbandonedInput,
  type ToolLedgerEntry,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import {
  codeModeCatalogInstruction,
  defaultCodeModeInlineBudget,
  renderCodeModeDescription,
  renderCodeModeInstructedDescription,
  type CodeModeStagingDescription
} from './catalog.ts'
import type { CodeModeExecutionResult, CodeModeExecutor, CodeModeStore } from './executor.ts'
import {
  boundCodeModeSegments,
  codeModeResultSegments,
  codeModeSegmentsContent,
  type CodeModeResultSegment
} from './output.ts'
import {
  CodeModeScriptStaged,
  defaultCodeModeLimits,
  runCodeModeScript,
  type CodeModeBeforeNestedCall,
  type CodeModeBeforeNestedCallInput,
  type CodeModeLimits,
  type CodeModeNestedCallSettledInput,
  type CodeModeScriptResult,
  type CodeModeStagingOptions
} from './script.ts'
import type {
  CodeModeInterruptedCall,
  CodeModeInterruptedCalls,
  CodeModeInterruptedCallStatus,
  CodeModeStructuredContent
} from './store.ts'

/** Default name of the code mode tool. */
export const codeModeToolName = 'codemode'

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
   * Runs before each nested call executes, with the nested call (id `<toolCallId>/<seq>`), the
   * called tool, its effective access, and the host context. A failure refuses that call: it
   * rejects in the script with the message (and `error.code` for a `CodeModeNestedCallRefused`)
   * and is recorded as an `error` without executing. Host decorators around the `ToolExecutor`
   * (outside `ResolvedToolSet.execute`) never see nested calls: put per-call run-authority checks
   * here or in registration-level wrappers. `readOnlyNestedCallGate` admits only reads.
   */
  readonly beforeNestedCall?: CodeModeBeforeNestedCall<CodeModeToolBeforeNestedCallInput<Context>>
  /**
   * Runs after each nested call that `beforeNestedCall` admitted, with its outcome: `success` (a
   * result without `isError`), `failure` (an error result or an unexpected failure), or
   * `interrupted` (cancelled, for example still running when the script ended). `durationMs`
   * covers the execution; `result` is present when the call produced one. Calls rejected by
   * `beforeNestedCall` or the call limit never ran and are not reported. The script waits for the
   * hook before it sees the call settle. A failing hook (a failure, a defect, or a synchronous
   * throw) is logged and never changes the call's result.
   */
  readonly afterNestedCall?: (input: CodeModeAfterNestedCallInput<Context>) => Effect.Effect<void>
  /**
   * Staged tool plans (ADR 0005). When the resolution offers staging (`resolveTools(..., { plans,
   * interactionHost })` with a plan review tool), scripts get `stage(name, args)` for stageable
   * approval-gated tools. `false` turns it off for this tool; `maxCalls` may only lower the
   * resolution's cap.
   */
  readonly staging?: CodeModeStagingOptions | false
  /**
   * Where the nested tool catalog goes (ADR 0007). `description` (default): in this tool's
   * description, which changes with the catalog. `instructions`: the description stays invariant
   * and the catalog (every namespace with its tool count, listed tools within `inlineBudget`) is
   * the resolution's `instructions` entry; hosts pass `ResolvedToolSet.instructions` to
   * `RunConfig.instructions`, so a change is appended to the conversation instead of rewriting the
   * cached request prefix.
   */
  readonly catalog?: 'description' | 'instructions'
}

/** What the code mode tool's `beforeNestedCall` sees: the call, its tool and access, the context. */
export type CodeModeToolBeforeNestedCallInput<Context> = CodeModeBeforeNestedCallInput & {
  readonly context: Context
}

export type CodeModeAfterNestedCallInput<Context> = CodeModeNestedCallSettledInput & {
  readonly context: Context
}

const CodeModeParams = Schema.Struct({
  code: Schema.String.annotate({
    description:
      'Raw JavaScript: the body of an async function. Top-level await and return work. Not a function declaration and not a module.'
  })
})

type CodeModeParams = typeof CodeModeParams.Type

/** The staging notice of a script that staged calls, after the bounded output. */
const stagingNotice = (staged: CodeModeScriptResult['staged']) => {
  if (staged === undefined) return undefined

  const plural = staged.count === 1 ? '' : 's'

  return CodeModeScriptStaged.$match(staged, {
    Discarded: ({ count }) =>
      `\n\nThe script failed, so its ${count} staged call${plural} ${count === 1 ? 'was' : 'were'} discarded; nothing was applied.`,
    SaveFailed: ({ count, message }) =>
      `\n\nThe script staged ${count} call${plural}, but the plan could not be saved (${message}); nothing was applied. Run the script again.`,
    Saved: ({ plan }) => `\n\n${stagedToolPlanNotice(plan)}`
  })
}

/**
 * The code mode tool's result for one script: bounded text (header, output, return value, error,
 * calls made), then the staging and input-required notices (never cut), the nested-call record,
 * usage, and `structuredContent.codemode`.
 */
const scriptToolResult = (
  call: ToolCall,
  limits: Required<CodeModeLimits>,
  script: CodeModeScriptResult
): ToolResult => {
  const execution: CodeModeExecutionResult = script.ok
    ? { ok: true, value: script.value, output: script.output }
    : { ok: false, error: script.error, output: script.output }

  const segments = codeModeResultSegments({
    result: execution,
    wallTimeMs: script.wallTimeMs,
    calls: script.calls,
    maxChars: limits.maxOutputChars,
    maxImages: limits.maxImages,
    maxImageBytes: limits.maxImageBytes
  })

  const { inputRequired, staged } = script

  const inputRequiredText =
    inputRequired.length === 0 ? undefined : `\n\n${inputRequiredNotice(inputRequired)}`

  // The staging and input notices follow the bounded output so a cut never hides them.
  const notices: ReadonlyArray<CodeModeResultSegment> = [
    stagingNotice(staged),
    inputRequiredText
  ].flatMap(text => (text === undefined ? [] : [{ type: 'text', text }]))

  const content = codeModeSegmentsContent([...segments, ...notices])

  const ok = script.ok && (staged === undefined || !CodeModeScriptStaged.$is('SaveFailed')(staged))

  const codemode: CodeModeStructuredContent['codemode'] =
    ok && script.ok && script.storeWrites !== undefined
      ? { ok: true, storeWrites: script.storeWrites }
      : { ok }

  const withPlan =
    staged !== undefined && CodeModeScriptStaged.$is('Saved')(staged)
      ? { ...codemode, plan: staged.plan }
      : codemode

  const structuredContent: CodeModeStructuredContent = {
    codemode: inputRequired.length === 0 ? withPlan : { ...withPlan, inputRequired }
  }

  type ResultFields = {
    toolCallId: string
    content: Content
    isError?: boolean
    structuredContent: CodeModeStructuredContent
    nestedCalls: CodeModeScriptResult['nestedCalls']
    usage?: AgentUsage
    usageIncomplete?: true
  }

  const fields: ResultFields = {
    toolCallId: call.id,
    content,
    structuredContent,
    nestedCalls: script.nestedCalls
  }

  if (!ok) {
    fields.isError = true
  }

  if (script.usage !== undefined) {
    fields.usage = script.usage
  }

  if (script.usageIncomplete !== undefined) {
    fields.usageIncomplete = script.usageIncomplete
  }

  return ToolResult.make(fields)
}

const argsPreviewChars = 200

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
    return `completed with an error: ${truncateCodePoints(outcome.error.message, nestedToolCallMaxErrorChars)}`

  if (Option.isSome(toolInputRequired(outcome.result))) return 'paused for input (not completed)'

  return outcome.result.isError === true ? 'completed with an error result' : 'applied'
}

/** The pauses of an abandoned execution's nested calls that paused for input (ADR 0014). */
const abandonedInputRequired = (nested: ReadonlyArray<ToolLedgerEntry>) =>
  mergeInputRequiredRefs(
    nested.flatMap(entry => {
      const outcome = entry.outcome

      if (outcome === undefined || Predicate.isTagged(outcome, 'Failed')) return []

      return Option.toArray(toolInputRequired(outcome.result))
    })
  )

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

    const { args, bytes, truncated } = boundNestedToolCallArgs(entry.args, argsBytes)

    // `argsTruncated`: the ledger already cut the arguments when the call was claimed.
    if (truncated || entry.argsTruncated) complete = false

    argsBytes += bytes
    calls.push({ key: entry.key, toolName: entry.toolName, args, status })
  }

  return { calls, complete, counts }
}

/**
 * The result of a code mode call whose earlier execution was abandoned (claimed, lease expired,
 * no result recorded). The script never runs again: the result lists that execution's ledgered
 * nested calls as applied, failed, or unknown, and says they were not undone. The text is bounded
 * by `maxOutputChars`; `structuredContent.codemode.interruptedCalls` carries the same entries for
 * hosts, bounded like `nestedCalls`. When the ledger cannot list them, the result stays
 * interrupted, says they may have been applied, and sets `interruptedCallsUnavailable` instead.
 * A plan the execution saved before it was abandoned (`plan`, from the plan store) and nested calls
 * that paused for input (listed `failed`) are named as for a finished script: `codemode.plan` and
 * `codemode.inputRequired`, with their notices after the bounded text, in that order.
 */
const abandonedScriptResult =
  (limits: Required<CodeModeLimits>) =>
  ({ call, nested, plan }: ToolLedgerAbandonedInput): ToolResult => {
    const maxChars = limits.maxOutputChars

    const listing =
      nested === undefined
        ? 'Its ledgered nested tool calls could not be listed (the tool ledger is unavailable), so any of them may already have been applied.'
        : nested.length === 0
          ? 'No ledgered nested tool calls were recorded for that execution.'
          : [
              `Ledgered nested tool calls of that execution (they were not undone):`,
              ...nested.map(
                entry =>
                  `- ${entry.key} ${entry.toolName} ${truncateCodePoints(entry.args, argsPreviewChars)}: ${nestedEntryState(entry)}`
              )
            ].join('\n')

    const text = [
      `Script interrupted: an earlier execution of this ${call.name} call (${call.id}) started but never recorded a result. The script was not run again.`,
      listing,
      'Calls the ledger policy skips (by default read-only calls) are not listed. Verify the state these calls affect before repeating any work.'
    ].join('\n\n')

    const inputRequired = nested === undefined ? [] : abandonedInputRequired(nested)

    const listed: CodeModeStructuredContent['codemode'] =
      nested === undefined
        ? { ok: false, interrupted: true, interruptedCallsUnavailable: true }
        : {
            ok: false,
            interrupted: true,
            interruptedCalls: interruptedCalls(
              nested,
              nestedToolCallRecordLimit(limits.maxNestedCalls)
            )
          }

    const withPlan = plan === undefined ? listed : { ...listed, plan }

    const structuredContent: CodeModeStructuredContent = {
      codemode: inputRequired.length === 0 ? withPlan : { ...withPlan, inputRequired }
    }

    // Where a finished script writes them, so the ledger's bounding keeps them (ADR 0005, 0014).
    const notices: ReadonlyArray<CodeModeResultSegment> = [
      plan === undefined ? undefined : `\n\n${stagedToolPlanNotice(plan)}`,
      inputRequired.length === 0 ? undefined : `\n\n${inputRequiredNotice(inputRequired)}`
    ].flatMap(text => (text === undefined ? [] : [{ type: 'text', text }]))

    return ToolResult.make({
      toolCallId: call.id,
      content: codeModeSegmentsContent([
        ...boundCodeModeSegments([{ type: 'text', text }], maxChars),
        ...notices
      ]),
      isError: true,
      structuredContent
    })
  }

/**
 * The code mode tool: one registration (default name `codemode`, input `{ code }`) whose scripts
 * call the other code-mode-callable tools of the same `resolveTools` resolution. Each call runs its
 * script with `runCodeModeScript` over the registration's `nested` executor: nested calls run
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

  const instructed = options.catalog === 'instructions'

  // In description mode `stage()` is documented once a stageable tool exists (the description
  // lists them anyway). In instructions mode the description must not depend on tools: staging
  // availability alone decides.
  const offered = (staging: CodeModeStagingDescription | undefined) =>
    options.staging === false ||
    staging === undefined ||
    (!instructed && staging.tools.length === 0)
      ? undefined
      : staging

  const run = ({
    call,
    context,
    params,
    nested
  }: ToolExecutionInput<Context> & { readonly params: CodeModeParams }) =>
    Effect.gen(function* () {
      if (nested === undefined) {
        return yield* Effect.fail(
          new ToolError({
            tool: name,
            cause: 'unavailable',
            message: `${name} requires nested tool access; resolve it with resolveTools.`
          })
        )
      }

      const loaded = options.loadStore === undefined ? {} : yield* options.loadStore(context)
      const { beforeNestedCall, afterNestedCall } = options

      const script = yield* runCodeModeScript({
        executor: options.executor,
        code: params.code,
        nested,
        parentCallId: call.id,
        limits,
        deadline: options.deadline?.(context),
        store: loaded,
        beforeNestedCall:
          beforeNestedCall === undefined
            ? undefined
            : input => beforeNestedCall({ ...input, context }),
        afterNestedCall:
          afterNestedCall === undefined
            ? undefined
            : input => afterNestedCall({ ...input, context }),
        staging: options.staging
      })

      return scriptToolResult(call, limits, script)
    })

  const registration = makeTool<Context, typeof CodeModeParams>({
    name,
    description: instructed
      ? renderCodeModeInstructedDescription({ store })
      : renderCodeModeDescription({ tools: [], inlineBudget, store }),
    parameters: CodeModeParams,
    access: 'write',
    nestedToolAccess: true,
    describe: ({ tools, staging }) => {
      const offeredStaging = offered(staging)

      if (instructed)
        return renderCodeModeInstructedDescription(
          offeredStaging === undefined ? { store } : { store, staging: offeredStaging }
        )

      return renderCodeModeDescription(
        offeredStaging === undefined
          ? { tools, inlineBudget, store }
          : { tools, inlineBudget, store, staging: offeredStaging }
      )
    },

    abandonedResult: abandonedScriptResult(limits),
    execute: run
  })

  if (!instructed) return registration

  const instruct: NestedToolInstructor = ({ tools, staging }) => {
    const offeredStaging = offered(staging)

    return codeModeCatalogInstruction(
      offeredStaging === undefined
        ? { tools, inlineBudget }
        : { tools, inlineBudget, staging: offeredStaging }
    )
  }

  return { ...registration, instruct }
}
