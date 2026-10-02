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
import type {
  CodeModeError,
  CodeModeExecuteOptions,
  CodeModeExecutionResult,
  CodeModeExecutor,
  CodeModeExecutorGlobal,
  CodeModeExecutorTool,
  CodeModeStoreWrites
} from './executor.ts'

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
}

type SlotOutcome = 'acquired' | 'aborted' | 'timeout'

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

const piTool = (tool: CodeModeExecutorTool): CodemodeTool => {
  const converted: CodemodeTool = {
    name: tool.name,
    execute: (args, context) => tool.execute(args, context)
  }

  if (tool.description !== undefined) converted.description = tool.description

  if (tool.inputSchema !== undefined) converted.inputSchema = tool.inputSchema

  if (tool.outputSchema !== undefined) converted.outputSchema = tool.outputSchema

  return converted
}

const piGlobal = (global: CodeModeExecutorGlobal): CodemodeTool => {
  const converted = piTool(global)

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

const fromPiResult = (result: CodemodeResult): CodeModeExecutionResult => {
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

  const { kind, name, message, stack } = result.error
  const named = name !== undefined && name.length > 0 && !message.startsWith(name)

  const error: MutableCodeModeError = {
    kind,
    message: named ? `${name}: ${message}` : message
  }

  if (stack !== undefined) error.stack = stack

  return { ok: false, error, output: result.output }
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A `CodeModeExecutor` on `@earendil-works/pi-codemode`: every execution gets a fresh QuickJS VM
 * (WebAssembly) in a fresh worker thread, closed when the execution ends. Applies the timeout,
 * heap cap, abort signal, and store, strips TypeScript annotations first, and caps concurrent
 * executions per executor; create one executor per process (module scope) so the cap is
 * per process.
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

  const run = async (code: string, execution: CodeModeExecuteOptions, queuedAt: number) => {
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
      memoryLimitBytes: execution.memoryLimitBytes
    }

    if (options.wasm !== undefined) sandboxOptions.wasm = options.wasm

    if (options.workerUrl !== undefined) sandboxOptions.workerUrl = options.workerUrl

    let sandbox: CodemodeSandbox

    try {
      sandbox = new CodemodeSandbox(sandboxOptions)
    } catch (error) {
      return failure({
        kind: 'sandbox',
        message: `Could not create the sandbox: ${describeError(error)}`
      })
    }

    try {
      return fromPiResult(
        await sandbox.execute(stripped.code, {
          signal: execution.signal,
          store: execution.store,
          timeoutMs
        })
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

      try {
        return await run(code, execution, queuedAt)
      } finally {
        slots.release()
      }
    }
  }
}
