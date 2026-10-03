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

/**
 * Evaluated in the VM before the script runs: `(tools) => guardedTools`. Each `tools.<name>(args)`
 * first walks `args` (cycle-safe; at most 10000 values and 64 levels deep, beyond which the host
 * still validates) and rejects with a `TypeError` naming the tool and path when JSON would change
 * the value instead of carrying it: non-finite numbers, `undefined`/function/symbol array items
 * and holes, function/symbol/bigint values, cycles, and objects that are neither plain (prototype
 * `Object.prototype` or `null`), arrays, nor have a `toJSON` method (`Date`). `undefined`-valued
 * keys stay allowed: JSON drops them, which means absent. A rejected call never reaches the host.
 * Unknown members fall through to pi's `tools` proxy (close-match suggestions). Not a security
 * boundary (`globalThis.tools` is unguarded): arguments are still decoded by the host.
 */
const toolsGuardSource = `(function (tools) {
  const plainJson = 'pass plain JSON (objects, arrays, strings, finite numbers, booleans, null)'
  const maxValues = 10000
  const maxDepth = 64
  const keyPath = (path, key) =>
    /^[A-Za-z_$][\\w$]*$/.test(key)
      ? (path === '' ? key : path + '.' + key)
      : path + '[' + JSON.stringify(key) + ']'
  const typeName = value => {
    const proto = Object.getPrototypeOf(value)
    const name = proto && typeof proto.constructor === 'function' ? proto.constructor.name : ''
    return name ? (/^[AEIOU]/.test(name) ? 'an ' : 'a ') + name : 'a non-plain object'
  }
  // Why JSON would not carry the value unchanged ("at <path> is ..."), or undefined.
  const check = (value, path, slot, ancestors, budget) => {
    const at = path === '' ? 'is ' : 'at ' + path + ' is '
    budget.values++
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return undefined
      case 'number':
        return Number.isFinite(value)
          ? undefined
          : at + value + '; pass a finite number' + (slot === 'key' ? ' or omit the key' : '')
      case 'undefined':
        return slot === 'item' ? at + 'undefined; arrays cannot hold undefined' : undefined
      case 'bigint':
      case 'function':
      case 'symbol':
        return at + 'a ' + typeof value + '; ' + plainJson
    }
    if (value === null || typeof value.toJSON === 'function') return undefined
    if (ancestors.includes(value)) return at + 'a circular reference; ' + plainJson
    if (ancestors.length >= maxDepth) return undefined
    const isArray = Array.isArray(value)
    const proto = Object.getPrototypeOf(value)
    if (!isArray && proto !== Object.prototype && proto !== null) {
      return at + typeName(value) + '; ' + plainJson
    }
    const keys = isArray ? undefined : Object.keys(value)
    const length = isArray ? value.length : keys.length
    let found
    ancestors.push(value)
    for (let i = 0; i < length && found === undefined && budget.values < maxValues; i++) {
      found = isArray
        ? check(value[i], path + '[' + i + ']', 'item', ancestors, budget)
        : check(value[keys[i]], keyPath(path, keys[i]), 'key', ancestors, budget)
    }
    ancestors.pop()
    return found
  }
  const wrap = (label, call) => async (...args) => {
    const found = check(args[0], '', 'root', [], { values: 0 })
    if (found !== undefined) throw new TypeError(label + ': argument ' + found)
    return call(...args)
  }
  const guarded = Object.create(null)
  const wrappers = new Map()
  // pi defines each identifier before its raw name, so the label is tools.<identifier>.
  for (const key of Object.keys(tools)) {
    const call = tools[key]
    if (!wrappers.has(call)) wrappers.set(call, wrap('tools.' + key, call))
    guarded[key] = wrappers.get(call)
  }
  return new Proxy(Object.freeze(guarded), {
    get: (target, key) => (key in target ? target[key] : tools[key])
  })
})`

// pi runs `(async (tools, console) => {<code>\n})`. The script runs in an inner function of the
// same shape whose `tools` is guarded; the prefix shares line 1 with the script (only line-1
// columns shift) and the guard follows the script, so its line numbers are unchanged.
const guardPrefix = 'return (async (tools, console) => {'

const guardSuffix = `\n})(${toolsGuardSource}(tools), console)`

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

const fromPiResult = (result: CodemodeResult, scriptLines: number): CodeModeExecutionResult => {
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

  if (stack !== undefined) error.stack = withoutWrapperFrames(stack, scriptLines)

  return { ok: false, error, output: result.output }
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A `CodeModeExecutor` on `@earendil-works/pi-codemode`: every execution gets a fresh QuickJS VM
 * (WebAssembly) in a fresh worker thread, closed when the execution ends. Applies the timeout,
 * heap cap, abort signal, and store, strips TypeScript annotations first, rejects tool arguments
 * that JSON would silently change inside the script (see `CodeModeExecutorTool`), and caps concurrent
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
        await sandbox.execute(`${guardPrefix}${stripped.code}${guardSuffix}`, {
          signal: execution.signal,
          store: execution.store,
          timeoutMs
        }),
        scriptLineCount(stripped.code)
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
