import { Option } from 'effect'
import * as Schema from 'effect/Schema'
import { codeModeCallLabels } from './catalog.ts'
import type { CodeModeExecuteOptions, CodeModeExecutorTool } from './executor.ts'

// The tools guard and tool-rejection encoding every executor running pi's prelude shares (the Node
// pi executor in `./node.ts`, the Dynamic Worker executor in `./cloudflare.ts`). Runtime-neutral.

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
const toolsGuardSource = `(function (tools, labels, unbound, rejectionPrefix) {
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
  const parse = JSON.parse
  const ErrorCtor = Error
  const startsWith = String.prototype.startsWith
  const sliceString = String.prototype.slice
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
  // The host sends every rejection of a tool call as the prefix and the JSON of { message, code? }
  // (pi only carries a message): rebuild the Error with its code.
  const restored = error => {
    const message = error instanceof ErrorCtor ? error.message : undefined
    if (typeof message !== 'string' || !apply(startsWith, message, [rejectionPrefix])) return error
    let payload
    try {
      payload = parse(apply(sliceString, message, [rejectionPrefix.length]))
    } catch {
      return error
    }
    if (payload === null || typeof payload !== 'object') return error
    const rebuilt = new ErrorCtor(typeof payload.message === 'string' ? payload.message : '')
    if (typeof payload.code === 'string') {
      defineProperty(rebuilt, 'code', { value: payload.code, writable: true, configurable: true })
    }
    return rebuilt
  }
  const wrap = (label, call) => async (...args) => {
    let json
    try {
      json = snapshot(args[0], '', '', 'root', { values: 0, depth: 0, ancestors: new SetCtor() })
    } catch (error) {
      if (error instanceof Rejected) throw new TypeErrorCtor(label + ': argument ' + error.message)
      throw error
    }
    try {
      return await call(json)
    } catch (error) {
      throw restored(error)
    }
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
  // Unbound keys (stage-only tools) reject with their hint instead of being undefined.
  const rejections = create(null)
  for (const [key, message] of unbound) {
    if (!(key in guarded)) rejections[key] = async () => { throw new TypeErrorCtor(message) }
  }
  return new Proxy(Object.freeze(guarded), {
    get: (target, key) => (key in target ? target[key] : key in rejections ? rejections[key] : tools[key])
  })
})`

// pi runs `(async (tools, console) => {<code>\n})`. The script runs in an inner function of the
// same shape whose `tools` is guarded; the prefix shares line 1 with the script (only line-1
// columns shift) and the guard follows the script, so its line numbers are unchanged.
export const guardPrefix = 'return (async (tools, console) => {'

/** JSON as a JavaScript expression (U+2028/U+2029 escaped for older parsers). */
const jsonSource = (value: unknown) =>
  JSON.stringify(value).replace(/[\u2028\u2029]/g, char =>
    char === '\u2028' ? '\\u2028' : '\\u2029'
  )

export const guardSuffix = (
  tools: ReadonlyArray<CodeModeExecutorTool>,
  unbound: CodeModeExecuteOptions['unbound']
) => {
  const names = tools.map(tool => tool.name)
  const labels = codeModeCallLabels(names)

  // `makeCodeModeTool` supplies each label; other callers get pi's binding rule.
  const pairs = tools.map((tool, index) => [
    tool.name,
    tool.callLabel ?? labels[index] ?? `tools[${JSON.stringify(tool.name)}]`
  ])

  const rejected = (unbound ?? []).map(entry => [entry.key, entry.message])

  return `\n})(${toolsGuardSource}(tools, ${jsonSource(pairs)}, ${jsonSource(rejected)}, ${jsonSource(rejectionPrefix)}), console)`
}

/**
 * pi passes only the message of a rejected tool call into the VM. Every tool rejection crosses as
 * this prefix and the JSON of `{ message, code? }`, which the tools guard turns back into an
 * `Error` with its `code`. Calls through the unguarded `globalThis.tools` see the encoded message.
 */
export const rejectionPrefix = '\u0000yolk-tool-rejection:'

type EncodedRejection = { message: string; code?: string }

const RejectionCode = Schema.Struct({ code: Schema.String })

export const encodedRejection = (error: unknown) => {
  const payload: EncodedRejection = {
    message: error instanceof Error ? error.message : String(error)
  }

  const code = Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(RejectionCode)(error), found => found.code)
  )

  if (code !== undefined) payload.code = code

  return new Error(`${rejectionPrefix}${JSON.stringify(payload)}`)
}
