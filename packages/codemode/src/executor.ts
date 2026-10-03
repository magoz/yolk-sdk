import type * as Schema from 'effect/Schema'
import type { ToolJsonSchema } from '@yolk-sdk/agent/protocol'

/** A JSON Schema document. Only shapes declarations; values are never validated against it. */
export type CodeModeJsonSchema = ToolJsonSchema

/** Store contents: small JSON values by key. */
export type CodeModeStore = Readonly<Record<string, Schema.Json>>

export type CodeModeToolContext = {
  /** Aborted when the script ends (unawaited calls), times out, or the execution is aborted. */
  readonly signal: AbortSignal
}

/**
 * A function a script can call. Tools are called as `tools.<identifier>(args)` and
 * `tools["<name>"](args)`; the identifier replaces characters that are not valid in a JavaScript
 * identifier with `_`. Arguments and results make a JSON round trip; a rejection surfaces in the
 * script as an `Error` with the same message (`makeCodeModeTool` rejects with
 * `<call label>: <message>`, the label being `tools.<identifier>` or `tools["<name>"]`).
 *
 * `args` is the JSON value of the script's first argument (`undefined` when there is none), read
 * once the way `JSON.stringify` reads it (getters and `toJSON` run once); the checked value is the
 * one sent. Executors reject, inside the script and without calling `execute`, values that JSON
 * would silently change instead of coercing them: non-finite numbers, invalid `Date`s,
 * `undefined`/function/symbol array items and holes, function/symbol/bigint values, cycles, and
 * non-plain objects without `toJSON` (`Map`, `Set`, `RegExp`, `Error`, class instances), including
 * inside `toJSON` results. `undefined`-valued object keys count as absent, as JSON drops them; a
 * valid `Date` passes as its ISO string. An argument too large or deep to check completely is
 * rejected, never sent unchecked (the pi executor: more than 100000 values or 64 levels). A
 * rejection names the call the way scripts reach it, as `makeCodeModeTool` does: the first tool
 * with an identifier is `tools.<identifier>`, a later one `tools["<name>"]`.
 */
export type CodeModeExecutorTool = {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: CodeModeJsonSchema
  readonly outputSchema?: CodeModeJsonSchema
  /** Diagnostic call label for rejection messages: `tools.<identifier>`, or `tools["<name>"]`
   * when an earlier tool holds the identifier (a tool whose name is taken too is unreachable and
   * the label only names it). `makeCodeModeTool` sets it; executors fall back to pi's binding rule.
   */
  readonly callLabel?: string
  readonly execute: (args: unknown, context: CodeModeToolContext) => Promise<unknown>
}

/**
 * A top-level function (`name`) or namespace member (`namespace.member`) for scripts. Globals are
 * host helpers: they are not tools and are not recorded as nested calls.
 */
export type CodeModeExecutorGlobal = Omit<CodeModeExecutorTool, 'callLabel'> & {
  /** `execute` receives every call argument as an array instead of the first one. */
  readonly spread?: boolean
  /** TypeScript parameter list and return type for declarations. */
  readonly signature?: string
}

/** One item of script output, in the order the script produced it. `data` is base64. */
export type CodeModeOutputItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/**
 * - `script`: the script threw, failed to parse, or its TypeScript could not be stripped.
 * - `timeout`: the deadline expired.
 * - `aborted`: the caller's signal fired.
 * - `sandbox`: the engine failed outside the script's control.
 */
export type CodeModeErrorKind = 'script' | 'timeout' | 'aborted' | 'sandbox'

export type CodeModeError = {
  readonly kind: CodeModeErrorKind
  readonly message: string
  readonly stack?: string
}

/** Keys a successful script changed with `store()`; `delete` lists keys stored as `undefined`. */
export type CodeModeStoreWrites = {
  readonly set: CodeModeStore
  readonly delete: ReadonlyArray<string>
}

export type CodeModeExecutionResult = {
  readonly ok: boolean
  /** The script's return value (JSON); absent when it returned nothing. */
  readonly value?: unknown
  readonly error?: CodeModeError
  /** Kept for failed executions too, up to the failure. */
  readonly output: ReadonlyArray<CodeModeOutputItem>
  /** Only successful executions report writes. */
  readonly storeWrites?: CodeModeStoreWrites
}

export type CodeModeExecuteOptions = {
  readonly tools: ReadonlyArray<CodeModeExecutorTool>
  readonly globals: ReadonlyArray<CodeModeExecutorGlobal>
  /** Overall deadline, including time spent in tools and waiting for a free execution slot. */
  readonly timeoutMs: number
  /** Heap cap of the script's VM. */
  readonly memoryLimitBytes: number
  /** Values the script reads with `load(key)`. */
  readonly store: CodeModeStore
  readonly signal: AbortSignal
}

/**
 * Runs one script. `code` is the body of an async function (top-level `await` and `return`) and
 * may carry TypeScript annotations: executors strip them or report a `script` error. The promise
 * resolves for every script outcome, including failures, timeouts, and aborts; a rejection is
 * treated as a `sandbox` failure. Running tool calls must be cancelled through their signal when
 * the script ends. Tool arguments follow the JSON rules of `CodeModeExecutorTool`: pass their JSON
 * value and reject what JSON would silently change.
 *
 * `@yolk-sdk/codemode/node` provides `makePiCodeModeExecutor`; hosts on other runtimes supply their
 * own engine behind this interface.
 */
export type CodeModeExecutor = {
  readonly execute: (
    code: string,
    options: CodeModeExecuteOptions
  ) => Promise<CodeModeExecutionResult>
}
