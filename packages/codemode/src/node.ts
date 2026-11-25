import * as nodeModule from 'node:module'
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  CodemodeSandbox,
  type CodemodeResult,
  type CodemodeSandboxOptions,
  type CodemodeTool,
  type CodemodeWasmModule
} from '@earendil-works/pi-codemode'
import {
  reportInternalError,
  type CodeModeError,
  type CodeModeExecuteOptions,
  type CodeModeExecutionResult,
  type CodeModeExecutor,
  type CodeModeExecutorGlobal,
  type CodeModeExecutorTool,
  type CodeModeInternalErrorObserver,
  type CodeModeStoreWrites
} from './executor.ts'
import { encodedRejection, guardPrefix, guardSuffix } from './guard.ts'

/** Default cap of concurrent script executions per executor. */
export const defaultMaxConcurrentExecutions = 4

export type PiCodeModeExecutorOptions = {
  /**
   * Compiled `quickjs-wasi/quickjs.wasm` (see pi's `loadQuickJSWasm`). Default: the file of the
   * installed `quickjs-wasi` package, compiled once per process.
   */
  readonly wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>
  /**
   * Worker entry that imports `@earendil-works/pi-codemode/worker`. Default: pi's own worker file,
   * which exists on disk when the package is not bundled (Next `serverExternalPackages`).
   */
  readonly workerUrl?: string | URL
  /** Concurrent executions of this executor; more wait for a free slot. Default 4. */
  readonly maxConcurrentExecutions?: number
  /**
   * Observes the executor's own failures, which the result only shows as fixed messages: `load`
   * (`new CodemodeSandbox` threw; `Could not create the sandbox.`) with the thrown error, and
   * `isolate` (pi's worker or QuickJS VM failed; `The script sandbox failed.`) with pi's `sandbox`
   * error record. Called once per failure, never for script errors, timeouts or aborts; what it
   * throws is ignored. For host logs: the cause may carry host details and must not reach the model.
   */
  readonly onInternalError?: CodeModeInternalErrorObserver
}

type SlotOutcome = 'acquired' | 'aborted' | 'timeout'

/** The worker an execution started, if any; its slot is released once the worker has exited. */
type StartedWorker = { exited?: Promise<void> }

type Waiter = (outcome: SlotOutcome) => void

/** Abort- and deadline-aware counting semaphore for executions. */
const makeExecutionSlots = (max: number) => {
  let active = 0
  const waiting: Array<Waiter> = []

  const acquire = (signal: AbortSignal, timeoutMs: number): Promise<SlotOutcome> => {
    if (signal.aborted) return Promise.resolve('aborted')

    if (active < max) {
      active++

      return Promise.resolve('acquired')
    }

    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle: Waiter = outcome => {
        const index = waiting.indexOf(settle)

        if (index !== -1) waiting.splice(index, 1)

        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }

      const onAbort = () => settle('aborted')

      waiting.push(settle)
      signal.addEventListener('abort', onAbort, { once: true })

      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => settle('timeout'), Math.max(0, timeoutMs))
      }
    })
  }

  const release = () => {
    const next = waiting[0]

    if (next === undefined) {
      active--
    } else {
      // The slot passes straight to the next waiter.
      next('acquired')
    }
  }

  return { acquire, release }
}

const wrapperPrefix = 'async function __yolkCodeMode() {\n'

const wrapperSuffix = '\n}'

const lineTerminators = /\r\n?|[\n\u2028\u2029]/g

/** Lines of the script as QuickJS counts them (at least; never fewer). */
const scriptLineCount = (code: string) => (code.match(lineTerminators)?.length ?? 0) + 1

const scriptFrame = /codemode\.js:(\d+):\d+/

/** Drops stack frames of the wrapper and guard, which sit below the script's last line. */
const withoutWrapperFrames = (stack: string, scriptLines: number) =>
  stack
    .split('\n')
    .filter(line => {
      const frame = scriptFrame.exec(line)

      return frame === null || Number(frame[1]) <= scriptLines
    })
    .join('\n')

const ErrorWithCode = Schema.Struct({ code: Schema.String })

const errorCode = (error: unknown) =>
  Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(ErrorWithCode)(error), e => e.code))

const syntaxLocation = (error: Error) => {
  const match = /^[^\n]*:(\d+)\n([^\n]*)\n([^\n]*)\n/.exec(error.stack ?? '')

  if (match === null) return ''

  const line = Number(match[1]) - 1

  return line >= 1 ? ` (line ${line})\n${match[2] ?? ''}\n${match[3] ?? ''}` : ''
}

const typeStripMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  if (errorCode(error) === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return `${message}. Write plain JavaScript: type annotations are stripped, but enums, namespaces, and parameter properties are not supported.`
  }

  const location = error instanceof Error ? syntaxLocation(error) : ''

  return `The script could not be parsed: ${message}${location}`
}

type Stripped =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: CodeModeError }

/**
 * Strips TypeScript annotations with Node's `stripTypeScriptTypes` (Node 22.13+; whitespace
 * replacement keeps line and column numbers). The script is wrapped in an async function so
 * top-level `return` and `await` parse. On Node without the API, code passes through unchanged.
 */
const stripTypes = (code: string): Stripped => {
  if (!Predicate.isFunction(nodeModule.stripTypeScriptTypes)) return { ok: true, code }

  try {
    const stripped = nodeModule.stripTypeScriptTypes(`${wrapperPrefix}${code}${wrapperSuffix}`, {
      mode: 'strip'
    })

    if (!stripped.startsWith(wrapperPrefix) || !stripped.endsWith(wrapperSuffix)) {
      return { ok: false, error: { kind: 'script', message: 'The script could not be parsed.' } }
    }

    return {
      ok: true,
      code: stripped.slice(wrapperPrefix.length, stripped.length - wrapperSuffix.length)
    }
  } catch (error) {
    return { ok: false, error: { kind: 'script', message: typeStripMessage(error) } }
  }
}

const piCallable = (
  tool: CodeModeExecutorTool | CodeModeExecutorGlobal,
  execute: CodemodeTool['execute']
): CodemodeTool => {
  const converted: CodemodeTool = { name: tool.name, execute }

  if (tool.description !== undefined) converted.description = tool.description

  if (tool.inputSchema !== undefined) converted.inputSchema = tool.inputSchema

  if (tool.outputSchema !== undefined) converted.outputSchema = tool.outputSchema

  return converted
}

const piTool = (tool: CodeModeExecutorTool): CodemodeTool =>
  piCallable(tool, (args, context) =>
    tool.execute(args, context).catch((error: unknown) => {
      throw encodedRejection(error)
    })
  )

const piGlobal = (global: CodeModeExecutorGlobal): CodemodeTool => {
  const converted = piCallable(global, (args, context) => global.execute(args, context))

  if (global.spread !== undefined) converted.spread = global.spread

  if (global.signature !== undefined) converted.signature = global.signature

  return converted
}

const failure = (error: CodeModeError): CodeModeExecutionResult => ({
  ok: false,
  error,
  output: []
})

const StoreWrites = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.Json),
  delete: Schema.Array(Schema.String)
})

const decodeStoreWrites = Schema.decodeUnknownOption(StoreWrites)

type MutableCodeModeError = {
  kind: CodeModeError['kind']
  message: string
  stack?: string
}

type MutableExecutionResult = {
  ok: boolean
  value?: unknown
  error?: CodeModeError
  output: CodeModeExecutionResult['output']
  storeWrites?: CodeModeStoreWrites
}

// pi marks `console.*` text with `console: true`; Yolk's output items carry only the text.
const fromPiOutput = (output: CodemodeResult['output']): CodeModeExecutionResult['output'] =>
  output.map(item =>
    item.type === 'text'
      ? { type: 'text', text: item.text }
      : { type: 'image', data: item.data, mimeType: item.mimeType }
  )

const fromPiResult = (
  piResult: CodemodeResult,
  scriptLines: number,
  onInternalError: CodeModeInternalErrorObserver | undefined
): CodeModeExecutionResult => {
  const result = { ...piResult, output: fromPiOutput(piResult.output) }

  if (result.ok) {
    const storeWrites = decodeStoreWrites(result.storeWrites)

    if (Option.isNone(storeWrites)) {
      return failure({
        kind: 'sandbox',
        message: 'The script reported store writes that are not JSON.'
      })
    }

    const converted: MutableExecutionResult = {
      ok: true,
      output: result.output,
      storeWrites: storeWrites.value
    }

    if (result.value !== undefined) converted.value = result.value

    return converted
  }

  // pi's own failures (QuickJS load, worker start, crash, exit) carry runtime text, not the script's.
  if (result.error.kind === 'sandbox') {
    reportInternalError(onInternalError, { stage: 'isolate', cause: result.error })

    return {
      ok: false,
      error: { kind: 'sandbox', message: 'The script sandbox failed.' },
      output: result.output
    }
  }

  const { kind, name, message, stack } = result.error
  const named = name !== undefined && name.length > 0 && !message.startsWith(name)

  const error: MutableCodeModeError = {
    kind,
    message: named ? `${name}: ${message}` : message
  }

  if (stack !== undefined) error.stack = withoutWrapperFrames(stack, scriptLines)

  return { ok: false, error, output: result.output }
}

/**
 * A `CodeModeExecutor` on `@earendil-works/pi-codemode`: every execution gets a fresh QuickJS VM
 * (WebAssembly) in a fresh worker thread, closed when the execution ends. Applies the timeout,
 * heap cap, abort signal, and store, strips TypeScript annotations first, rejects tool arguments
 * that JSON would silently change inside the script (see `CodeModeExecutorTool`), and caps concurrent
 * executions per executor; create one executor per process (module scope) so the cap is
 * per process.
 *
 * Errors: what the script controls reaches the caller (its thrown error's name, message and stack,
 * parse errors, tool and global rejections). Failures of the sandbox itself become fixed messages
 * (`sandbox`), never pi's or the runtime's text; `onInternalError` receives the original error.
 *
 * Node only. The worker inherits a copy of `process.env` (scripts cannot read it: the VM has no
 * `process`). Under Next.js, list `@yolk-sdk/codemode`, `@earendil-works/pi-codemode`, and
 * `quickjs-wasi` in `serverExternalPackages` so the worker file and wasm stay on disk.
 */
export const makePiCodeModeExecutor = (
  options: PiCodeModeExecutorOptions = {}
): CodeModeExecutor => {
  const slots = makeExecutionSlots(
    Math.max(1, Math.floor(options.maxConcurrentExecutions ?? defaultMaxConcurrentExecutions))
  )

  const run = async (
    code: string,
    execution: CodeModeExecuteOptions,
    queuedAt: number,
    onWorkerStarted: (exited: Promise<void>) => void
  ) => {
    const remaining = () => execution.timeoutMs - (Date.now() - queuedAt)
    const stripped = stripTypes(code)

    if (!stripped.ok) return failure(stripped.error)

    const timeoutMs = remaining()

    if (timeoutMs <= 0) {
      return failure({
        kind: 'timeout',
        message: `Execution timed out after ${execution.timeoutMs} ms`
      })
    }

    const sandboxOptions: CodemodeSandboxOptions = {
      tools: execution.tools.map(piTool),
      globals: execution.globals.map(piGlobal),
      timeoutMs,
      memoryLimitBytes: execution.memoryLimitBytes,
      onWorkerStarted
    }

    if (options.wasm !== undefined) sandboxOptions.wasm = options.wasm

    if (options.workerUrl !== undefined) sandboxOptions.workerUrl = options.workerUrl

    let sandbox: CodemodeSandbox

    try {
      sandbox = new CodemodeSandbox(sandboxOptions)
    } catch (error) {
      reportInternalError(options.onInternalError, { stage: 'load', cause: error })

      return failure({ kind: 'sandbox', message: 'Could not create the sandbox.' })
    }

    try {
      return fromPiResult(
        await sandbox.execute(
          `${guardPrefix}${stripped.code}${guardSuffix(execution.tools, execution.unbound)}`,
          {
            signal: execution.signal,
            store: execution.store,
            timeoutMs
          }
        ),
        scriptLineCount(stripped.code),
        options.onInternalError
      )
    } finally {
      await sandbox.close()
    }
  }

  return {
    execute: async (code, execution) => {
      const queuedAt = Date.now()
      const slot = await slots.acquire(execution.signal, execution.timeoutMs)

      if (slot === 'aborted') return failure({ kind: 'aborted', message: 'Execution aborted' })

      if (slot === 'timeout') {
        return failure({
          kind: 'timeout',
          message: `Execution timed out after ${execution.timeoutMs} ms while waiting for a free execution slot`
        })
      }

      // pi settles once it has asked the worker to stop, not once it exited: the slot stays taken
      // until the worker is gone, so the cap bounds live workers.
      const worker: StartedWorker = {}

      try {
        return await run(code, execution, queuedAt, exited => {
          worker.exited = exited
        })
      } finally {
        if (worker.exited === undefined) {
          slots.release()
        } else {
          void worker.exited.then(slots.release, slots.release)
        }
      }
    }
  }
}
