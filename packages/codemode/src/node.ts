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
import { codeModeCallLabels } from './catalog.ts'
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

/** Most values one argument may hold; a larger argument is rejected. */
const maxArgumentValues = 100_000

/** Deepest object/array nesting one argument may have; deeper arguments are rejected. */
const maxArgumentDepth = 64

/**
 * Evaluated in the VM before the script runs: `(tools, labels) => guardedTools`, with `labels` the
 * `[name, callLabel]` pairs of the tools in order (`codeModeCallLabels`). Each call walks its first
 * argument once, the way `JSON.stringify` reads it (each own enumerable string key and each array
 * index read once, so getters run once; a callable `toJSON` is called once with the key, `''` at
 * the root, and its result is walked at the same path), and builds a fresh copy (null-prototype
 * objects and arrays) that is what the call sends. It rejects with a `TypeError` naming the call
 * label and path when JSON would change the value instead of carrying it: non-finite numbers,
 * invalid `Date`s, `undefined`/function/symbol array items and holes, function/symbol/bigint
 * values, cycles, and objects that are neither plain (prototype `Object.prototype` or `null`) nor
 * arrays and have no `toJSON`. An argument with more than `maxArgumentValues` values or nested more
 * than `maxArgumentDepth` levels is rejected too, never sent unchecked. `undefined`-valued keys are
 * left out (absent, as JSON drops them); the same object twice (not a cycle) is copied twice. An
 * error thrown by a getter or `toJSON` rejects the call with that error. A rejected call never
 * reaches the host. Every member of pi's `tools` is wrapped; unknown members fall through to pi's
 * proxy (close-match suggestions). Not a security boundary (`globalThis.tools` is unguarded):
 * arguments are still decoded by the host.
 */
const toolsGuardSource = `(function (tools, labels) {
  // Captured before the script runs, so a script that changes built-ins cannot change the checks.
  const { apply, getPrototypeOf, setPrototypeOf } = Reflect
  const isFinite = Number.isFinite
  const isArray = Array.isArray
  const { keys, create, defineProperty } = Object
  const getTime = Date.prototype.getTime
  const TypeErrorCtor = TypeError
  const SetCtor = Set
  const setAdd = Set.prototype.add
  const setHas = Set.prototype.has
  const setDelete = Set.prototype.delete
  const ObjectProto = Object.prototype
  const { trunc, min } = Math
  const stringify = JSON.stringify
  const plainJson = 'pass plain JSON (objects, arrays, strings, finite numbers, booleans, null)'
  const maxValues = ${maxArgumentValues}
  const maxDepth = ${maxArgumentDepth}
  class Rejected {
    constructor(message) {
      defineProperty(this, 'message', { value: message })
    }
  }
  const keyPath = (path, key) =>
    /^[A-Za-z_$][\\w$]*$/.test(key)
      ? (path === '' ? key : path + '.' + key)
      : path + '[' + stringify(key) + ']'
  const typeName = value => {
    const proto = getPrototypeOf(value)
    const name = proto && typeof proto.constructor === 'function' ? proto.constructor.name : ''
    return name ? (/^[AEIOU]/.test(name) ? 'an ' : 'a ') + name : 'a non-plain object'
  }
  // The JSON copy of a value already read from its holder at key (undefined: absent), or throws
  // Rejected with why JSON would not carry it unchanged.
  const snapshot = (read, key, path, slot, walk) => {
    const at = path === '' ? 'is ' : 'at ' + path + ' is '
    if (++walk.values > maxValues) {
      throw new Rejected('has more than ' + maxValues + ' values; split the work across calls')
    }
    let value = read
    const kind = typeof value
    if ((kind === 'object' && value !== null) || kind === 'function' || kind === 'bigint') {
      // The intrinsic getTime reads a Date's internal time (and throws for anything else).
      let time
      try {
        time = apply(getTime, value, [])
      } catch {
        time = undefined
      }
      if (time !== undefined && !isFinite(time)) {
        throw new Rejected(at + 'an invalid Date; pass a valid Date or an ISO string')
      }
      const toJSON = value.toJSON
      if (typeof toJSON === 'function') value = apply(toJSON, value, [key])
    }
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value
      case 'number':
        if (isFinite(value)) return value
        throw new Rejected(
          at + value + '; pass a finite number' + (slot === 'key' ? ' or omit the key' : '')
        )
      case 'undefined':
        if (slot === 'item') throw new Rejected(at + 'undefined; arrays cannot hold undefined')
        return undefined
      case 'bigint':
      case 'function':
      case 'symbol':
        throw new Rejected(at + 'a ' + typeof value + '; ' + plainJson)
    }
    if (value === null) return null
    if (apply(setHas, walk.ancestors, [value])) {
      throw new Rejected(at + 'a circular reference; ' + plainJson)
    }
    if (walk.depth >= maxDepth) {
      throw new Rejected('at ' + path + ' is nested more than ' + maxDepth + ' levels deep')
    }
    const array = isArray(value)
    if (!array) {
      const proto = getPrototypeOf(value)
      if (proto !== ObjectProto && proto !== null) {
        throw new Rejected(at + typeName(value) + '; ' + plainJson)
      }
    }
    apply(setAdd, walk.ancestors, [value])
    walk.depth++
    let copy
    if (array) {
      // LengthOfArrayLike, read once, as JSON.stringify does.
      // Unary plus is ToNumber: one coercion, and it throws for a bigint as JSON.stringify does.
      const raw = +value.length
      const length = raw > 0 ? min(trunc(raw), 9007199254740991) : 0
      // No prototype: no inherited toJSON or index setter can change the checked copy when pi
      // serializes it (still an array to JSON.stringify).
      copy = []
      setPrototypeOf(copy, null)
      for (let i = 0; i < length; i++) {
        copy[i] = snapshot(value[i], '' + i, path + '[' + i + ']', 'item', walk)
      }
    } else {
      copy = create(null)
      // Indexed over the fresh key array: no iterator a script could replace.
      const names = keys(value)
      for (let i = 0; i < names.length; i++) {
        const name = names[i]
        const item = snapshot(value[name], name, keyPath(path, name), 'key', walk)
        if (item !== undefined) copy[name] = item
      }
    }
    walk.depth--
    apply(setDelete, walk.ancestors, [value])
    return copy
  }
  const wrap = (label, call) => async (...args) => {
    let json
    try {
      json = snapshot(args[0], '', '', 'root', { values: 0, depth: 0, ancestors: new SetCtor() })
    } catch (error) {
      if (error instanceof Rejected) throw new TypeErrorCtor(label + ': argument ' + error.message)
      throw error
    }
    return call(json)
  }
  // Each tool's function sits at tools[name] unless an earlier tool holds that key, in which case
  // that earlier function is already wrapped.
  const wrappers = new Map()
  for (const [name, label] of labels) {
    const call = name in tools ? tools[name] : undefined
    if (typeof call === 'function' && !wrappers.has(call)) wrappers.set(call, wrap(label, call))
  }
  const guarded = Object.create(null)
  for (const key of Object.keys(tools)) {
    const call = tools[key]
    if (!wrappers.has(call)) wrappers.set(call, wrap('tools[' + JSON.stringify(key) + ']', call))
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

/** JSON as a JavaScript expression (U+2028/U+2029 escaped for older parsers). */
const jsonSource = (value: unknown) =>
  JSON.stringify(value).replace(/[\u2028\u2029]/g, char =>
    char === '\u2028' ? '\\u2028' : '\\u2029'
  )

const guardSuffix = (tools: ReadonlyArray<CodeModeExecutorTool>) => {
  const names = tools.map(tool => tool.name)
  const labels = codeModeCallLabels(names)

  // `makeCodeModeTool` supplies each label; other callers get pi's binding rule.
  const pairs = tools.map((tool, index) => [
    tool.name,
    tool.callLabel ?? labels[index] ?? `tools[${JSON.stringify(tool.name)}]`
  ])

  return `\n})(${toolsGuardSource}(tools, ${jsonSource(pairs)}), console)`
}

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
        await sandbox.execute(`${guardPrefix}${stripped.code}${guardSuffix(execution.tools)}`, {
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
