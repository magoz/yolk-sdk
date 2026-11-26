import { RpcTarget } from 'cloudflare:workers'
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { toCodemodeIdentifier } from '@earendil-works/pi-codemode/declarations'
import type * as Sucrase from 'sucrase'
import {
  reportInternalError,
  type CodeModeError,
  type CodeModeExecuteOptions,
  type CodeModeExecutionResult,
  type CodeModeExecutor,
  type CodeModeExecutorGlobal,
  type CodeModeExecutorTool,
  type CodeModeInternalError,
  type CodeModeInternalErrorObserver,
  type CodeModeOutputItem,
  type CodeModeStoreWrites
} from './executor.ts'
import { encodedRejection, guardPrefix, guardSuffix } from './guard.ts'
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS, PRELUDE_SOURCE } from './pi-prelude.ts'

/** The Worker a script runs in, as `WorkerLoader.load` takes it. */
export type WorkerLoaderCode = {
  readonly compatibilityDate: string
  readonly mainModule: string
  readonly modules: Readonly<Record<string, string>>
  /** `null`: the script's isolate has no network access. */
  readonly globalOutbound: null
  /** CPU time the isolate may use per invocation; past it the runtime throws. */
  readonly limits: { readonly cpuMs: number }
}

/**
 * The part of a Worker Loader binding (`worker_loaders` in the Worker's config) the executor uses.
 * Workers types' `WorkerLoader` satisfies it. The loaded Worker and its entrypoint are disposed
 * (`Symbol.dispose`) when an execution ends, when they have it.
 */
export interface WorkerLoader {
  load(code: WorkerLoaderCode): { getEntrypoint(): unknown }
}

export type DynamicWorkerCodeModeExecutorOptions = {
  /**
   * The Worker Loader binding, read when a script runs (for example `() => env.LOADER` with `env`
   * from `cloudflare:workers`), so the executor can be created at module scope.
   */
  readonly loader: () => WorkerLoader
  /** Compatibility date of the script's isolate. Default `2026-05-12`. */
  readonly compatibilityDate?: string
  /**
   * CPU milliseconds a script's isolate may use (`limits.cpuMs` of the loaded Worker), floored,
   * at least 1. Default `defaultDynamicWorkerCpuMs` (500). This is the real ceiling of a script:
   * the execution's `timeoutMs` only answers the caller early and cannot stop a synchronous loop,
   * which keeps running (and is billed) until it reaches this limit. Time spent waiting for tool
   * calls is not CPU time. A script past it fails with `timeout` (`Execution exceeded its CPU limit
   * of <cpuMs> ms`).
   */
  readonly cpuMs?: number
  /**
   * Observes the executor's own failures, which the result and the script only see as fixed
   * messages: `load` (the binding, `load()` or `getEntrypoint()` threw), `isolate` (the isolate's
   * `run` failed), `cpu-limit` (it failed for its CPU limit), and `host-call` (a call's RPC to the
   * host failed; at most `maxDynamicWorkerHostCallFailureReports` per execution, and since the
   * script's isolate reports it, a script can fake one). Called once per failure with the original
   * error, never for script errors, timeouts or aborts; what it throws is ignored. For host logs:
   * the cause may carry host details and must not reach the model.
   */
  readonly onInternalError?: CodeModeInternalErrorObserver
}

/** Default compatibility date of a script's isolate. */
export const defaultDynamicWorkerCompatibilityDate = '2026-05-12'

/** Default CPU limit of a script's isolate, in milliseconds. */
export const defaultDynamicWorkerCpuMs = 500

/**
 * `host-call` failures reported to `onInternalError` per execution; later ones are dropped. The
 * script's isolate reports them, so this bounds what a script can make the host log.
 */
export const maxDynamicWorkerHostCallFailureReports = 10

type CallReply =
  | { readonly ok: true; readonly payload: string | null }
  | { readonly ok: false; readonly message: string }

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a tool or global call still pending when the execution ended (or arriving later) gets. */
const executionEndedMessage =
  'The script ended before this call settled; await every tool call before returning.'

// Tool rejections cross encoded for the tools guard; globals keep pi's plain message.
const ended = (kind: string): CallReply => ({
  ok: false,
  message:
    kind === 'global'
      ? executionEndedMessage
      : encodedRejection(new Error(executionEndedMessage)).message
})

const OutputItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('image'), data: Schema.String, mimeType: Schema.String })
])

const decodeOutputItem = Schema.decodeUnknownOption(OutputItem)

const parseJson = (text: string): Option.Option<unknown> => {
  try {
    const value: unknown = JSON.parse(text)

    return Option.some(value)
  } catch {
    return Option.none()
  }
}

/** Raw JSON the host keeps of a script's output batches: its output, escaped, with framing. */
const maxOutputBatchChars = 2 * MAX_OUTPUT_CHARS + 64 * MAX_OUTPUT_ITEMS

const outputItemChars = (item: CodeModeOutputItem) =>
  item.type === 'text' ? item.text.length : item.data.length

/**
 * The host side of a script's calls, passed to the isolate as an RPC stub. Its calls live as long
 * as the execution (`signal`): once it aborts, calls still pending answer at once with
 * `executionEndedMessage` (the tools see the signal abort), and later calls get the same answer
 * without running. A Dynamic Worker counts as in flight while it waits on a call to the host, so an
 * unawaited call must not keep it open (4 per request, 10 per Durable Object).
 *
 * Each call also carries the output the script printed since its previous call (`output`), so an
 * isolate that dies (its CPU limit) or an execution the host ends early (timeout, abort) keeps the
 * output that reached the host. The script can reach this stub, so what it sends is decoded and
 * capped by the prelude's own output limits.
 */
class ToolHost extends RpcTarget {
  readonly #tools: ReadonlyMap<string, CodeModeExecutorTool>
  readonly #globals: ReadonlyMap<string, CodeModeExecutorGlobal>
  readonly #signal: AbortSignal
  readonly #ended: Promise<void>
  readonly #onInternalError: CodeModeInternalErrorObserver | undefined
  #callFailureReports = 0
  /** Output batches as the script sent them (JSON), decoded only when `output` is read. */
  readonly #outputBatches: Array<string> = []
  #outputBatchChars = 0

  constructor(
    tools: ReadonlyArray<CodeModeExecutorTool>,
    globals: ReadonlyArray<CodeModeExecutorGlobal>,
    signal: AbortSignal,
    onInternalError: CodeModeInternalErrorObserver | undefined
  ) {
    super()
    this.#tools = new Map(tools.map(tool => [tool.name, tool]))
    this.#globals = new Map(globals.map(global => [global.name, global]))
    this.#signal = signal
    this.#onInternalError = onInternalError
    this.#ended = new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  /**
   * `kind` is `call` (a tool) or `global`; arguments and results cross as JSON text. `outputJson`
   * is the output printed since the previous call (a JSON array of output items), or null.
   */
  async call(
    kind: string,
    name: string,
    argsJson: string | null,
    outputJson: unknown = null
  ): Promise<CallReply> {
    this.#receiveOutput(outputJson)

    if (this.#signal.aborted) return ended(kind)

    const reply = this.#execute(kind, name, argsJson)

    return await Promise.race([reply, this.#ended.then(() => ended(kind))])
  }

  /**
   * The isolate reports a call whose RPC to the host failed (the script got the fixed
   * `hostCallFailedMessage`), with the error it saw, also after the execution ended. Bounded by
   * `maxDynamicWorkerHostCallFailureReports`, since the script shares the isolate.
   */
  async reportCallFailure(cause: unknown): Promise<void> {
    if (this.#callFailureReports >= maxDynamicWorkerHostCallFailureReports) return

    this.#callFailureReports++
    reportInternalError(this.#onInternalError, { stage: 'host-call', cause })
  }

  /** The output that reached the host, in order. */
  /**
   * The output that reached the host, in order: decoded and capped by the prelude's limits, and
   * cut at the first batch or item past them, so it stays a prefix of what the script printed.
   */
  get output(): ReadonlyArray<CodeModeOutputItem> {
    const output: Array<CodeModeOutputItem> = []
    let chars = 0

    for (const batch of this.#outputBatches) {
      const items = parseJson(batch)

      if (Option.isNone(items) || !Array.isArray(items.value)) return output

      for (const value of items.value) {
        const item = Option.getOrUndefined(decodeOutputItem(value))

        if (item === undefined) return output

        chars += outputItemChars(item)

        if (chars > MAX_OUTPUT_CHARS || output.length >= MAX_OUTPUT_ITEMS) return output

        output.push(item)
      }
    }

    return output
  }

  // Only stored: most executions end with the isolate's reply and never read it. Bounded by raw
  // size (JSON escaping at most doubles text; item framing is small) so a script cannot make the
  // host hold more, and ignored once the execution ended.
  #receiveOutput(outputJson: unknown) {
    if (!Predicate.isString(outputJson) || this.#signal.aborted) return

    const chars = this.#outputBatchChars + outputJson.length

    if (chars > maxOutputBatchChars) return

    this.#outputBatchChars = chars
    this.#outputBatches.push(outputJson)
  }

  async #execute(kind: string, name: string, argsJson: string | null): Promise<CallReply> {
    const target = kind === 'global' ? this.#globals.get(name) : this.#tools.get(name)

    if (target === undefined) return { ok: false, message: `Unknown ${kind} ${name}` }

    try {
      const args: unknown = argsJson === null ? undefined : JSON.parse(argsJson)
      const result: unknown = await target.execute(args, { signal: this.#signal })

      // `JSON.stringify` returns undefined for values JSON cannot carry (a function).
      const payload: string | undefined = result === undefined ? undefined : JSON.stringify(result)

      return { ok: true, payload: payload === undefined ? null : payload }
    } catch (error) {
      // Tool rejections carry their code through the tools guard; globals keep pi's plain message.
      const message = kind === 'global' ? describeError(error) : encodedRejection(error).message

      return { ok: false, message }
    }
  }
}

// The prelude defines `console` on `globalThis`, which a Worker isolate already owns; the script
// receives the prelude's console as a parameter anyway.
const preludeConsole =
  'Object.defineProperty(globalThis, "console", { value: console, enumerable: true });'

const prelude = PRELUDE_SOURCE.replace(preludeConsole, '')

const wrapperPrefix = 'async function __yolkCodeMode() {\n'

const wrapperSuffix = '\n}'

type Stripped =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: CodeModeError }

/**
 * Strips TypeScript annotations with Sucrase's `transform` (lines are kept). The script is wrapped
 * in an async function so top-level `return` and `await` parse.
 */
const stripTypes = (transform: typeof Sucrase.transform, code: string): Stripped => {
  try {
    const stripped = transform(`${wrapperPrefix}${code}${wrapperSuffix}`, {
      transforms: ['typescript'],
      disableESTransforms: true
    }).code

    const start = stripped.indexOf(wrapperPrefix)
    const end = stripped.lastIndexOf(wrapperSuffix)

    if (start === -1 || end <= start) {
      return { ok: false, error: { kind: 'script', message: 'The script could not be parsed.' } }
    }

    return { ok: true, code: stripped.slice(start + wrapperPrefix.length, end) }
  } catch (error) {
    return {
      ok: false,
      error: { kind: 'script', message: `The script could not be parsed: ${describeError(error)}` }
    }
  }
}

/**
 * What a call gets when its RPC to the host itself fails (the host never rejects: it answers with
 * a reply). Fixed, so runtime error text never reaches the script.
 */
const hostCallFailedMessage = 'The call could not reach the host.'

/**
 * The isolate's main module: a `WorkerEntrypoint` whose `run` evaluates pi's prelude around the
 * guarded script and resolves with `{ ok, payload, writes, output }` once the script is done.
 */
const scriptModule = (script: string) => `import { WorkerEntrypoint } from "cloudflare:workers";
const createPrelude = ${prelude};
export default class CodeModeScript extends WorkerEntrypoint {
  async run(host, toolsJson, globalsJson, storeJson) {
    return await new Promise((resolve) => {
      const output = [];
      // Output not yet sent to the host; each call carries it, so output printed before the
      // script's last call survives an isolate that dies (its CPU limit). A batch whose call
      // fails to reach the host is not sent again.
      let sent = 0;
      const unsent = () => {
        if (sent === output.length) return null;
        const items = output.slice(sent);
        sent = output.length;
        return JSON.stringify(items);
      };
      let api;
      const bridge = (kind, a, b, c) => {
        if (kind === "call" || kind === "global") {
          host.call(kind, b, c === undefined ? null : c, unsent()).then(
            (reply) => reply.ok ? api.settle(a, true, reply.payload === null ? undefined : reply.payload) : api.settle(a, false, reply.message),
            (error) => {
              Promise.resolve().then(() => host.reportCallFailure(error)).catch(() => {});
              api.settle(a, false, ${JSON.stringify(hostCallFailedMessage)});
            }
          );
          return;
        }
        if (kind === "output") {
          // "text" and "console" (console.*) items are both text.
          output.push(a === "image" ? { type: "image", data: b, mimeType: c } : { type: "text", text: b });
          return;
        }
        if (kind === "done") resolve({ ok: a, payload: b === undefined ? null : b, writes: c === undefined ? null : c, output });
      };
      api = createPrelude(bridge, toolsJson, globalsJson, storeJson);
      api.run(async (tools, console) => {${script}
});
    });
  }
}
`

const IsolateReply = Schema.Struct({
  ok: Schema.Boolean,
  payload: Schema.NullOr(Schema.String),
  writes: Schema.NullOr(Schema.String),
  output: Schema.Array(Schema.Unknown)
})

const WriteEntries = Schema.Array(
  Schema.Union([Schema.Tuple([Schema.String]), Schema.Tuple([Schema.String, Schema.String])])
)

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

const ScriptError = Schema.Struct({
  name: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.String)
})

/** pi reports writes as `[key, json]` entries, `[key]` for a deleted key. */
const decodeStoreWrites = (writesJson: string | null): Option.Option<CodeModeStoreWrites> => {
  const entries = Option.flatMap(
    writesJson === null ? Option.some<unknown>([]) : parseJson(writesJson),
    Schema.decodeUnknownOption(WriteEntries)
  )

  if (Option.isNone(entries)) return Option.none()

  const set: Record<string, Schema.Json> = {}
  const deleted: Array<string> = []

  for (const entry of entries.value) {
    if (entry.length === 1) {
      deleted.push(entry[0])
      continue
    }

    const value = Option.flatMap(parseJson(entry[1]), decodeJson)

    if (Option.isNone(value)) return Option.none()

    set[entry[0]] = value.value
  }

  return Option.some({ set, delete: deleted })
}

type MutableCodeModeError = {
  kind: CodeModeError['kind']
  message: string
  stack?: string
}

type MutableExecutionResult = {
  ok: boolean
  value?: unknown
  error?: CodeModeError
  output: ReadonlyArray<CodeModeOutputItem>
  storeWrites?: CodeModeStoreWrites
}

const failure = (error: CodeModeError): CodeModeExecutionResult => ({
  ok: false,
  error,
  output: []
})

const malformed = failure({ kind: 'sandbox', message: 'The script returned a malformed result.' })

const fromIsolate = (reply: unknown): CodeModeExecutionResult => {
  const decoded = Schema.decodeUnknownOption(IsolateReply)(reply)

  if (Option.isNone(decoded)) return malformed

  const { ok, payload, writes } = decoded.value
  const output = decoded.value.output.flatMap(item => Option.toArray(decodeOutputItem(item)))

  if (ok) {
    const storeWrites = decodeStoreWrites(writes)
    const value = payload === null ? Option.some(undefined) : parseJson(payload)

    if (Option.isNone(storeWrites)) {
      return failure({
        kind: 'sandbox',
        message: 'The script reported store writes that are not JSON.'
      })
    }

    if (Option.isNone(value)) return malformed

    const converted: MutableExecutionResult = { ok: true, output, storeWrites: storeWrites.value }

    if (value.value !== undefined) converted.value = value.value

    return converted
  }

  const described = Option.getOrUndefined(
    Option.flatMap(
      payload === null ? Option.none() : parseJson(payload),
      Schema.decodeUnknownOption(ScriptError)
    )
  )

  const message = described?.message ?? 'Script failed'
  const name = described?.name ?? ''

  const error: MutableCodeModeError = {
    kind: 'script',
    message: name !== '' && !message.startsWith(name) ? `${name}: ${message}` : message
  }

  if (described?.stack !== undefined) error.stack = described.stack

  return { ok: false, error, output }
}

/** The isolate's `CodeModeScript` entrypoint as its RPC stub exposes it. */
type ScriptEntrypoint = {
  run(host: ToolHost, toolsJson: string, globalsJson: string, storeJson: string): Promise<unknown>
}

// A Worker entrypoint stub answers every method name with a callable RPC method.
const isScriptEntrypoint = (value: unknown): value is ScriptEntrypoint =>
  Predicate.hasProperty(value, 'run') && Predicate.isFunction(value.run)

const loadFailed = failure({ kind: 'sandbox', message: 'Could not load the script sandbox.' })

const executionAborted = failure({ kind: 'aborted', message: 'Execution aborted' })

const sandboxFailed = failure({ kind: 'sandbox', message: 'The script sandbox failed.' })

// workerd's errors for a Worker past its CPU time ("exceeded CPU time limit", "CPU limit").
const isCpuLimitError = (error: unknown) => /\bcpu\b.*\blimit/i.test(describeError(error))

/** How an execution settled, with the executor's own failure behind it, if any. */
type Settled = {
  readonly result: CodeModeExecutionResult
  /** Set when the isolate answered, whose reply carries the complete output. */
  readonly replied?: true
  readonly internalError?: CodeModeInternalError
}

/**
 * A failed `run` (the isolate itself failed, not the script): never the runtime's text, which is
 * not the script's and may carry host details. The original error goes to `onInternalError`.
 */
const fromRunFailure = (error: unknown, cpuMs: number): Settled =>
  isCpuLimitError(error)
    ? {
        result: failure({
          kind: 'timeout',
          message: `Execution exceeded its CPU limit of ${cpuMs} ms`
        }),
        internalError: { stage: 'cpu-limit', cause: error }
      }
    : { result: sandboxFailed, internalError: { stage: 'isolate', cause: error } }

/**
 * Disposes a loaded Worker or entrypoint stub when it has `Symbol.dispose`, so its native handle is
 * released now instead of at garbage collection. Never throws.
 */
const disposeQuietly = (resource: unknown) => {
  if (!Predicate.hasProperty(resource, Symbol.dispose)) return

  const dispose = resource[Symbol.dispose]

  if (!Predicate.isFunction(dispose)) return

  try {
    dispose.call(resource)
  } catch {
    // Best effort: disposal never changes the execution's result.
  }
}

/**
 * A `CodeModeExecutor` on Cloudflare Dynamic Workers (a Worker Loader binding): each execution
 * loads a fresh isolate with no network access (`globalOutbound: null`) running pi's prelude
 * (`tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `console`, `store`/`load`) around the script,
 * and its tool and global calls come back to this Worker over RPC. The same script contract as
 * `makePiCodeModeExecutor` (TypeScript stripped first, the same tools guard and rejection codes),
 * which a Worker cannot run (it needs a worker thread). Every execution is one `load()`, one billed
 * Dynamic Worker.
 *
 * Limits: the isolate gets `limits.cpuMs` (`cpuMs`, default 500), the real ceiling of a script.
 * The timeout and abort signal only answer the caller early: the isolate may keep running until
 * its CPU limit. When the execution ends (result, timeout, abort, failure), tool and global calls
 * still pending are answered at once with a fixed "ended" rejection and their signal aborts, later
 * calls get the same rejection without running, and the loaded Worker and its entrypoint are
 * disposed. `memoryLimitBytes` does not apply (Workers cap isolate memory themselves), and there is
 * no per-executor concurrency cap.
 *
 * Errors: what the script controls reaches the caller as on Node (its thrown error's name, message
 * and stack, parse errors, tool and global rejections). Failures of the loader or the isolate
 * itself become fixed messages (`sandbox`, or `timeout` past the CPU limit), never the runtime's
 * text; `onInternalError` receives the original error for host logs.
 *
 * Needs the `cloudflare:workers` module, so only a Worker can load this subpath.
 */
export const makeDynamicWorkerCodeModeExecutor = (
  options: DynamicWorkerCodeModeExecutorOptions
): CodeModeExecutor => {
  const cpuMs = Math.max(1, Math.floor(options.cpuMs ?? defaultDynamicWorkerCpuMs))

  const execute = async (code: string, execution: CodeModeExecuteOptions) => {
    if (execution.signal.aborted) return executionAborted

    // Sucrase (about half a megabyte of parser) loads when the first script runs, not when this
    // subpath is imported: a Worker that builds the executor but runs no script never evaluates
    // it. The runtime's module cache loads it once per isolate. Keep it a dynamic `import()`.
    const transform = await import('sucrase').then(
      sucrase => sucrase.transform,
      (cause: unknown) => {
        reportInternalError(options.onInternalError, { stage: 'load', cause })

        return undefined
      }
    )

    // The caller may have aborted while Sucrase loaded, before the abort listener below exists.
    if (execution.signal.aborted) return executionAborted

    if (transform === undefined) return loadFailed

    const stripped = stripTypes(transform, code)

    if (!stripped.ok) return failure(stripped.error)

    // The execution's lifetime: aborted when it ends for any reason, which ends its calls.
    const controller = new AbortController()
    const abort = () => controller.abort()

    execution.signal.addEventListener('abort', abort, { once: true })

    const script = `${guardPrefix}${stripped.code}${guardSuffix(execution.tools, execution.unbound)}`

    const toolsJson = JSON.stringify(
      execution.tools.map(tool => ({
        name: tool.name,
        jsName: toCodemodeIdentifier(tool.name),
        description: tool.description ?? ''
      }))
    )

    const globalsJson = JSON.stringify(
      execution.globals.map(global => ({ name: global.name, spread: global.spread === true }))
    )

    const storeJson = JSON.stringify(
      Object.fromEntries(
        Object.entries(execution.store).map(([key, value]) => [key, JSON.stringify(value)])
      )
    )

    const host = new ToolHost(
      execution.tools,
      execution.globals,
      controller.signal,
      options.onInternalError
    )

    let timer: ReturnType<typeof setTimeout> | undefined
    let worker: unknown
    let entrypoint: unknown

    try {
      try {
        const loaded = options.loader().load({
          compatibilityDate: options.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
          mainModule: 'script.js',
          modules: { 'script.js': scriptModule(script) },
          globalOutbound: null,
          limits: { cpuMs }
        })

        worker = loaded
        entrypoint = loaded.getEntrypoint()
      } catch (error) {
        reportInternalError(options.onInternalError, { stage: 'load', cause: error })

        return loadFailed
      }

      if (!isScriptEntrypoint(entrypoint)) {
        return failure({ kind: 'sandbox', message: 'The loaded Worker has no run entrypoint.' })
      }

      const run = entrypoint.run(host, toolsJson, globalsJson, storeJson).then(
        (reply): Settled => ({ result: fromIsolate(reply), replied: true }),
        (error: unknown) => fromRunFailure(error, cpuMs)
      )

      const deadline = new Promise<Settled>(resolve => {
        timer = setTimeout(
          () =>
            resolve({
              result: failure({
                kind: 'timeout',
                message: `Execution timed out after ${execution.timeoutMs} ms`
              })
            }),
          Math.max(0, execution.timeoutMs)
        )
      })

      const aborted = new Promise<Settled>(resolve => {
        controller.signal.addEventListener('abort', () => resolve({ result: executionAborted }), {
          once: true
        })
      })

      // Only the failure that settled the execution is reported: an isolate failing after a
      // timeout or abort already answered is not.
      const settled = await Promise.race([run, deadline, aborted])

      if (settled.internalError !== undefined) {
        reportInternalError(options.onInternalError, settled.internalError)
      }

      // The isolate ran on this thread, and a Worker's clock moves only at I/O and timers: a
      // CPU-limit failure arrives with the clock where the script started spinning. One timer turn
      // (after the race, so it cannot turn the failure into a timeout) lets the caller's next clock
      // read, the run's wall time, see the time it took.
      if (settled.internalError?.stage === 'cpu-limit') {
        await new Promise(resolve => setTimeout(resolve, 0))
      }

      // Without the isolate's reply, the output is what reached the host with the script's calls.
      return settled.replied === true ? settled.result : { ...settled.result, output: host.output }
    } catch (error) {
      reportInternalError(options.onInternalError, { stage: 'isolate', cause: error })

      return sandboxFailed
    } finally {
      if (timer !== undefined) clearTimeout(timer)

      execution.signal.removeEventListener('abort', abort)
      // Ends the execution: pending calls answer at once and their tools' signal aborts.
      controller.abort()
      disposeQuietly(entrypoint)
      disposeQuietly(worker)
    }
  }

  return { execute }
}
