import { RpcTarget } from 'cloudflare:workers'
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { toCodemodeIdentifier } from '@earendil-works/pi-codemode/declarations'
import { transform } from 'sucrase'
import type {
  CodeModeError,
  CodeModeExecuteOptions,
  CodeModeExecutionResult,
  CodeModeExecutor,
  CodeModeExecutorGlobal,
  CodeModeExecutorTool,
  CodeModeOutputItem,
  CodeModeStoreWrites
} from './executor.ts'
import { encodedRejection, guardPrefix, guardSuffix } from './guard.ts'
import { PRELUDE_SOURCE } from './pi-prelude.ts'

/** The Worker a script runs in, as `WorkerLoader.load` takes it. */
export type WorkerLoaderCode = {
  readonly compatibilityDate: string
  readonly mainModule: string
  readonly modules: Readonly<Record<string, string>>
  /** `null`: the script's isolate has no network access. */
  readonly globalOutbound: null
}

/**
 * The part of a Worker Loader binding (`worker_loaders` in the Worker's config) the executor uses.
 * Workers types' `WorkerLoader` satisfies it.
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
}

/** Default compatibility date of a script's isolate. */
export const defaultDynamicWorkerCompatibilityDate = '2026-05-12'

type CallReply =
  | { readonly ok: true; readonly payload: string | null }
  | { readonly ok: false; readonly message: string }

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The host side of a script's calls, passed to the isolate as an RPC stub. */
class ToolHost extends RpcTarget {
  readonly #tools: ReadonlyMap<string, CodeModeExecutorTool>
  readonly #globals: ReadonlyMap<string, CodeModeExecutorGlobal>
  readonly #signal: AbortSignal

  constructor(
    tools: ReadonlyArray<CodeModeExecutorTool>,
    globals: ReadonlyArray<CodeModeExecutorGlobal>,
    signal: AbortSignal
  ) {
    super()
    this.#tools = new Map(tools.map(tool => [tool.name, tool]))
    this.#globals = new Map(globals.map(global => [global.name, global]))
    this.#signal = signal
  }

  /** `kind` is `call` (a tool) or `global`; arguments and results cross as JSON text. */
  async call(kind: string, name: string, argsJson: string | null): Promise<CallReply> {
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
 * Strips TypeScript annotations with Sucrase (lines are kept). The script is wrapped in an async
 * function so top-level `return` and `await` parse.
 */
const stripTypes = (code: string): Stripped => {
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
 * The isolate's main module: a `WorkerEntrypoint` whose `run` evaluates pi's prelude around the
 * guarded script and resolves with `{ ok, payload, writes, output }` once the script is done.
 */
const scriptModule = (script: string) => `import { WorkerEntrypoint } from "cloudflare:workers";
const createPrelude = ${prelude};
export default class CodeModeScript extends WorkerEntrypoint {
  async run(host, toolsJson, globalsJson, storeJson) {
    return await new Promise((resolve) => {
      const output = [];
      let api;
      const bridge = (kind, a, b, c) => {
        if (kind === "call" || kind === "global") {
          host.call(kind, b, c === undefined ? null : c).then(
            (reply) => reply.ok ? api.settle(a, true, reply.payload === null ? undefined : reply.payload) : api.settle(a, false, reply.message),
            (error) => api.settle(a, false, String(error && error.message ? error.message : error))
          );
          return;
        }
        if (kind === "output") {
          output.push(a === "text" ? { type: "text", text: b } : { type: "image", data: b, mimeType: c });
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

const OutputItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('image'), data: Schema.String, mimeType: Schema.String })
])

const decodeOutputItem = Schema.decodeUnknownOption(OutputItem)

const WriteEntries = Schema.Array(
  Schema.Union([Schema.Tuple([Schema.String]), Schema.Tuple([Schema.String, Schema.String])])
)

const decodeJson = Schema.decodeUnknownOption(Schema.Json)

const ScriptError = Schema.Struct({
  name: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.String)
})

const parseJson = (text: string): Option.Option<unknown> => {
  try {
    const value: unknown = JSON.parse(text)

    return Option.some(value)
  } catch {
    return Option.none()
  }
}

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

/**
 * A `CodeModeExecutor` on Cloudflare Dynamic Workers (a Worker Loader binding): each execution
 * loads a fresh isolate with no network access (`globalOutbound: null`) running pi's prelude
 * (`tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `console`, `store`/`load`) around the script,
 * and its tool and global calls come back to this Worker over RPC. The same script contract as
 * `makePiCodeModeExecutor` (TypeScript stripped first, the same tools guard and rejection codes),
 * which a Worker cannot run (it needs a worker thread).
 *
 * The timeout and abort signal end the execution on the host side; the isolate is dropped with
 * it. `memoryLimitBytes` does not apply (Workers cap isolate memory themselves), and there is no
 * per-executor concurrency cap. Needs the `cloudflare:workers` module, so only a Worker can load
 * this subpath.
 */
export const makeDynamicWorkerCodeModeExecutor = (
  options: DynamicWorkerCodeModeExecutorOptions
): CodeModeExecutor => ({
  execute: async (code: string, execution: CodeModeExecuteOptions) => {
    if (execution.signal.aborted) return failure({ kind: 'aborted', message: 'Execution aborted' })

    const stripped = stripTypes(code)

    if (!stripped.ok) return failure(stripped.error)

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

    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const worker = options.loader().load({
        compatibilityDate: options.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
        mainModule: 'script.js',
        modules: { 'script.js': scriptModule(script) },
        globalOutbound: null
      })

      const host = new ToolHost(execution.tools, execution.globals, controller.signal)
      const entrypoint = worker.getEntrypoint()

      if (!isScriptEntrypoint(entrypoint)) {
        return failure({ kind: 'sandbox', message: 'The loaded Worker has no run entrypoint.' })
      }

      const run = entrypoint.run(host, toolsJson, globalsJson, storeJson)

      const deadline = new Promise<CodeModeExecutionResult>(resolve => {
        timer = setTimeout(
          () =>
            resolve(
              failure({
                kind: 'timeout',
                message: `Execution timed out after ${execution.timeoutMs} ms`
              })
            ),
          Math.max(0, execution.timeoutMs)
        )
      })

      const aborted = new Promise<CodeModeExecutionResult>(resolve => {
        controller.signal.addEventListener(
          'abort',
          () => resolve(failure({ kind: 'aborted', message: 'Execution aborted' })),
          { once: true }
        )
      })

      return await Promise.race([run.then(fromIsolate), deadline, aborted])
    } catch (error) {
      return failure({
        kind: 'sandbox',
        message: `The script sandbox failed: ${describeError(error)}`
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)

      execution.signal.removeEventListener('abort', abort)
      // Cancels tool calls still running (their signal) once the script ended.
      controller.abort()
    }
  }
})
