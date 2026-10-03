import { Deferred, Effect, Fiber, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { providerToolDefs, ToolApprovalPolicy, ToolResult } from '@yolk-sdk/agent/protocol'
import { makeQuestionToolRegistration, makeTool, resolveTools } from '@yolk-sdk/agent/tools'
import {
  codeModeStoreFromToolResults,
  makeCodeModeTool,
  type CodeModeExecuteOptions,
  type CodeModeExecutorTool
} from '../src/index.ts'
import { makePiCodeModeExecutor } from '../src/node.ts'
import {
  context,
  HitsOutput,
  moduleOf,
  QueryParams,
  queryTool,
  runCode,
  text,
  type TestContext,
  type ToolLog
} from './fixtures.ts'

const executor = makePiCodeModeExecutor()

const codemode = (options: Partial<Parameters<typeof makeCodeModeTool<TestContext>>[0]> = {}) =>
  makeCodeModeTool<TestContext>({ executor, ...options })

describe('code mode with the pi executor', () => {
  it.live('runs nested calls through the resolved tool set with the host context', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [
          moduleOf('host', [codemode()]),
          moduleOf('docs', [
            queryTool('search_docs', { log }),
            queryTool('lookup', { log, structured: true, exposure: { callableBy: 'codemode' } })
          ])
        ],
        `const a = await tools.search_docs({ query: 'x' })
         const b = await tools.lookup({ query: 'y' })
         text('got ' + a)
         return { a, ids: b.hits.map(hit => hit.id) }`
      )

      expect(result.isError).toBeUndefined()
      expect(text(result.content)).toMatch(/^Script completed in \d+ ms\./)
      expect(text(result.content)).toContain('Output:\ngot search_docs:x')
      expect(text(result.content)).toContain('Return value:\n{"a":"search_docs:x","ids":["y"]}')
      expect(log).toEqual(['search_docs:x:tenant_1', 'lookup:y:tenant_1'])
      expect(result.nestedCalls?.complete).toBe(true)
      expect(result.nestedCalls?.calls.map(call => [call.id, call.name, call.status])).toEqual([
        ['call_1/1', 'search_docs', 'ok'],
        ['call_1/2', 'lookup', 'ok']
      ])
      expect(result.structuredContent).toEqual({ codemode: { ok: true } })
    })
  )

  it.live('validates nested params through the registry and never executes invalid calls', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [queryTool('search_docs', { log })])],
        `try { await tools.search_docs({ query: 42 }) } catch (error) { return 'rejected: ' + error.message }`
      )

      expect(log).toEqual([])
      expect(text(result.content)).toContain(
        'rejected: tools.search_docs: Invalid search_docs arguments'
      )
      expect(result.nestedCalls?.calls[0]?.status).toBe('error')
    })
  )

  it.live('keeps fail-closed tools absent and unreachable', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const approved = queryTool('approved_write', { log })

      const modules = [
        moduleOf('host', [codemode()]),
        moduleOf('docs', [
          { ...approved, approval: ToolApprovalPolicy.make({ mode: 'manual' }) },
          makeQuestionToolRegistration<TestContext>({
            execute: ({ call }) => {
              log.push('question')

              return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'answered' }))
            }
          }),
          queryTool('model_only', { log, exposure: { callableBy: 'model' } })
        ])
      ]

      const result = yield* runCode(
        modules,
        `const names = ALL_TOOLS.map(tool => tool.name)
         const errors = []
         for (const name of ['approved_write', 'question', 'model_only']) {
           try { await tools[name]({ query: 'x' }) } catch (error) { errors.push(error.message) }
         }
         return { names, errors }`
      )

      const toolSet = yield* resolveTools(modules, context)

      expect(log).toEqual([])
      expect(text(result.content)).toContain('"names":[]')
      expect(text(result.content)).toContain('tools.approved_write does not exist')
      expect(toolSet.tools.find(tool => tool.name === 'codemode')?.description).not.toContain(
        'approved_write'
      )
    })
  )

  it.live('calls codemode-only tools from scripts but never sends them to providers', () =>
    Effect.gen(function* () {
      const modules = [
        moduleOf('host', [codemode()]),
        moduleOf('docs', [
          queryTool('hidden', { exposure: { callableBy: 'codemode', discovery: 'search' } })
        ])
      ]

      const toolSet = yield* resolveTools(modules, context)
      const result = yield* runCode(modules, `return await tools.hidden({ query: 'q' })`)

      expect(providerToolDefs(toolSet.tools).map(tool => tool.name)).toEqual(['codemode'])
      expect(text(result.content)).toContain('"hidden:q"')
    })
  )

  it.live('resolves structured content for output-schema tools and text otherwise', () =>
    Effect.gen(function* () {
      const bare = makeTool<TestContext, typeof QueryParams>({
        name: 'bare',
        description: 'Declares an output schema but returns no structured content',
        parameters: QueryParams,
        output: HitsOutput,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'plain' }))
      })

      const result = yield* runCode(
        [
          moduleOf('host', [codemode()]),
          moduleOf('docs', [
            queryTool('texty'),
            queryTool('structured', { structured: true }),
            bare
          ])
        ],
        `return [
           await tools.texty({ query: 'a' }),
           await tools.structured({ query: 'b' }),
           await tools.bare({ query: 'c' })
         ]`
      )

      expect(text(result.content)).toContain(
        'Return value:\n["texty:a",{"hits":[{"id":"b","score":1}]},"plain"]'
      )
    })
  )

  it.live('rejects failed nested calls and reports partial output and calls made', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [
          moduleOf('host', [codemode()]),
          moduleOf('docs', [queryTool('send', { log }), queryTool('broken', { fail: true, log })])
        ],
        `await tools.send({ query: 'a' })
         await tools.send({ query: 'b' })
         text('before')
         try { await tools.broken({ query: 'c' }) } catch (error) { text('caught: ' + error.message) }
         throw new TypeError('boom')`
      )

      const body = text(result.content)

      expect(result.isError).toBe(true)
      expect(body).toMatch(/^Script failed after \d+ ms\./)
      expect(body).toContain('Output:\nbefore\ncaught: tools.broken: broken failed for c')
      expect(body).toContain(
        'Script error: script: TypeError: boom\n    at <anonymous> (codemode.js:5:'
      )
      expect(body).toContain(
        'Tool calls made before the failure (they are not undone): send: 2 ok; broken: 1 error.'
      )
      expect(result.structuredContent).toEqual({ codemode: { ok: false } })
      expect(result.nestedCalls?.calls[2]).toMatchObject({
        id: 'call_1/3',
        status: 'error',
        error: 'broken failed for c'
      })
    })
  )

  const ProbeParams = Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    tags: Schema.optional(Schema.Array(Schema.String)),
    since: Schema.optional(Schema.String)
  })

  /** Answers with the decoded params as JSON and logs every execution. */
  const probeTool = (log: ToolLog) =>
    makeTool<TestContext, typeof ProbeParams>({
      name: 'args-probe',
      description: 'Echoes its decoded arguments',
      parameters: ProbeParams,
      access: 'read',
      execute: ({ call, params }) =>
        Effect.sync(() => {
          log.push(JSON.stringify(params))

          return ToolResult.make({ toolCallId: call.id, content: JSON.stringify(params) })
        })
    })

  it.live('carries arguments as JSON: undefined keys and null optionals are absent', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [probeTool(log)])],
        `return [
           await tools.args_probe({ query: 'a', limit: undefined, tags: undefined }),
           await tools.args_probe({ query: 'b', limit: null, tags: null, since: null }),
           await tools['args-probe']({ query: 'c', since: new Date(0) })
         ]`
      )

      expect(result.isError).toBeUndefined()
      expect(log).toEqual([
        '{"query":"a"}',
        '{"query":"b"}',
        '{"query":"c","since":"1970-01-01T00:00:00.000Z"}'
      ])
      // Records keep the arguments as sent (compact JSON), before the registry drops nulls.
      expect(result.nestedCalls?.calls.map(call => call.args)).toEqual([
        '{"query":"a"}',
        '{"query":"b","limit":null,"tags":null,"since":null}',
        '{"query":"c","since":"1970-01-01T00:00:00.000Z"}'
      ])
    })
  )

  it.live('rejects arguments JSON would change inside the script without calling the tool', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [probeTool(log)])],
        `const attempts = [
           { query: 'a', limit: NaN },
           { query: 'a', limit: Infinity },
           { query: 'a', limit: -Infinity },
           { query: 'a', tags: ['x', undefined] },
           { query: 'a', tags: new Map() },
           { query: 'a', tags: [() => 1] }
         ]
         const messages = []
         for (const args of attempts) {
           try { await tools.args_probe(args) } catch (error) { messages.push(error.name + ': ' + error.message) }
         }
         return messages`
      )

      const plain = 'pass plain JSON (objects, arrays, strings, finite numbers, booleans, null)'

      expect(returnValue(result)).toEqual([
        'TypeError: tools.args_probe: argument at limit is NaN; pass a finite number or omit the key',
        'TypeError: tools.args_probe: argument at limit is Infinity; pass a finite number or omit the key',
        'TypeError: tools.args_probe: argument at limit is -Infinity; pass a finite number or omit the key',
        'TypeError: tools.args_probe: argument at tags[1] is undefined; arrays cannot hold undefined',
        `TypeError: tools.args_probe: argument at tags is a Map; ${plain}`,
        `TypeError: tools.args_probe: argument at tags[0] is a function; ${plain}`
      ])
      // Rejected before leaving the VM: never executed and never recorded.
      expect(log).toEqual([])
      expect(result.nestedCalls?.calls).toEqual([])
    })
  )

  const JsonParams = Schema.Struct({ value: Schema.optional(Schema.Unknown) })

  /** Answers with the decoded params as JSON and logs every execution. */
  const jsonProbeTool = (log: ToolLog) =>
    makeTool<TestContext, typeof JsonParams>({
      name: 'json_probe',
      description: 'Echoes any JSON value',
      parameters: JsonParams,
      access: 'read',
      execute: ({ call, params }) =>
        Effect.sync(() => {
          log.push(JSON.stringify(params))

          return ToolResult.make({ toolCallId: call.id, content: JSON.stringify(params) })
        })
    })

  const plainJson = 'pass plain JSON (objects, arrays, strings, finite numbers, booleans, null)'

  type GuardCase = {
    readonly name: string
    /** Script expression of the call (`tools.json_probe` unless set). */
    readonly call?: string
    /** Script expression of the argument. */
    readonly args: string
    /** `ok: <params JSON>` when the call executes, else `<Error name>: <message>`. */
    readonly expected: string
  }

  const reject = (message: string, tool = 'json_probe') =>
    `TypeError: tools.${tool}: argument ${message}`

  const nested = (levels: number, leaf: string) =>
    `${'{"a":'.repeat(levels)}${leaf}${'}'.repeat(levels)}`

  const budgetFit = JSON.stringify({ value: Array.from({ length: 99_998 }, () => 0) })

  const guardCases: ReadonlyArray<GuardCase> = [
    {
      name: 'cycle',
      args: `(() => { const c = { a: 1 }; c.self = c; return { value: c } })()`,
      expected: reject(`at value.self is a circular reference; ${plainJson}`)
    },
    {
      name: 'hole',
      args: `{ value: [1, , 3] }`,
      expected: reject('at value[1] is undefined; arrays cannot hold undefined')
    },
    {
      name: 'Set',
      args: `{ value: new Set([1]) }`,
      expected: reject(`at value is a Set; ${plainJson}`)
    },
    {
      name: 'class instance',
      args: `{ value: new (class Point {})() }`,
      expected: reject(`at value is a Point; ${plainJson}`)
    },
    {
      name: 'RegExp',
      args: `{ value: /x/ }`,
      expected: reject(`at value is a RegExp; ${plainJson}`)
    },
    {
      name: 'Error',
      args: `{ value: new Error('x') }`,
      expected: reject(`at value is an Error; ${plainJson}`)
    },
    {
      name: 'bigint',
      args: `{ value: 1n }`,
      expected: reject(`at value is a bigint; ${plainJson}`)
    },
    {
      name: 'symbol',
      args: `{ value: Symbol('s') }`,
      expected: reject(`at value is a symbol; ${plainJson}`)
    },
    {
      name: 'Promise',
      args: `{ value: Promise.resolve(1) }`,
      expected: reject(`at value is a Promise; ${plainJson}`)
    },
    {
      name: 'non-identifier key',
      args: `{ value: { 'a-b': [NaN] } }`,
      expected: reject('at value["a-b"][0] is NaN; pass a finite number')
    },
    {
      name: 'invalid Date',
      args: `{ value: new Date('not a date') }`,
      expected: reject('at value is an invalid Date; pass a valid Date or an ISO string')
    },
    {
      name: 'toJSON result with NaN',
      call: 'tools.args_probe',
      args: `{ query: 'a', toJSON() { return { query: 'a', limit: NaN } } }`,
      expected: reject('at limit is NaN; pass a finite number or omit the key', 'args_probe')
    },
    {
      name: 'toJSON that throws',
      args: `{ value: { toJSON() { throw new RangeError('no JSON') } } }`,
      expected: 'RangeError: no JSON'
    },
    {
      name: 'NaN after a large array',
      call: 'tools.args_probe',
      args: `{ query: 'a', tags: Array(10000).fill('x'), limit: NaN }`,
      expected: reject('at limit is NaN; pass a finite number or omit the key', 'args_probe')
    },
    {
      name: 'value budget exceeded',
      args: `{ value: Array(100000).fill(0) }`,
      expected: reject('has more than 100000 values; split the work across calls')
    },
    {
      name: 'depth exceeded',
      args: `(() => { let v = 1; for (let i = 0; i < 70; i++) v = { a: v }; return { value: v } })()`,
      expected: reject(`at value${'.a'.repeat(63)} is nested more than 64 levels deep`)
    },
    {
      name: 'getter read once',
      call: 'tools.args_probe',
      args: `(() => { let reads = 0; return { query: 'a', get limit() { reads++; return reads === 1 ? 1 : NaN } } })()`,
      expected: 'ok: {"query":"a","limit":1}'
    },
    {
      name: 'DAG alias',
      args: `(() => { const shared = { n: 1 }; return { value: [shared, { again: shared }] } })()`,
      expected: 'ok: {"value":[{"n":1},{"again":{"n":1}}]}'
    },
    {
      name: 'null-prototype object',
      args: `{ value: Object.assign(Object.create(null), { a: 1, b: undefined }) }`,
      expected: 'ok: {"value":{"a":1}}'
    },
    {
      name: 'valid Date',
      args: `{ value: new Date(0) }`,
      expected: 'ok: {"value":"1970-01-01T00:00:00.000Z"}'
    },
    {
      name: 'depth at the limit',
      args: `(() => { let v = 1; for (let i = 0; i < 63; i++) v = { a: v }; return { value: v } })()`,
      expected: `ok: {"value":${nested(63, '1')}}`
    },
    {
      name: 'value budget at the limit',
      args: `{ value: Array(99998).fill(0) }`,
      expected: `ok: ${budgetFit.length} chars`
    }
  ]

  it.live('checks a snapshot of each argument and sends that snapshot', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const attempts = guardCases
        .map(entry => `await attempt(() => ${entry.call ?? 'tools.json_probe'}(${entry.args}))`)
        .join('\n')

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [jsonProbeTool(log), probeTool(log)])],
        `const results = []
         const attempt = async call => {
           try {
             const value = await call()
             results.push('ok: ' + (value.length > 1000 ? value.length + ' chars' : value))
           } catch (error) {
             results.push(error.name + ': ' + error.message)
           }
         }
         ${attempts}
         return results`
      )

      expect(result.isError).toBeUndefined()
      // Keyed by case name so a failure shows which case changed.
      expect(Object.fromEntries(zipNames(guardCases, returnValue(result)))).toEqual(
        Object.fromEntries(guardCases.map(entry => [entry.name, entry.expected]))
      )

      const executed = guardCases.filter(entry => entry.expected.startsWith('ok: '))

      // Rejected calls never execute and are never recorded; the rest execute exactly once.
      expect(log).toEqual([
        '{"query":"a","limit":1}',
        '{"value":[{"n":1},{"again":{"n":1}}]}',
        '{"value":{"a":1}}',
        '{"value":"1970-01-01T00:00:00.000Z"}',
        `{"value":${nested(63, '1')}}`,
        budgetFit
      ])
      expect(result.nestedCalls?.calls.map(call => call.status)).toEqual(executed.map(() => 'ok'))
    })
  )

  it.live('keeps checking and sending the snapshot when the script changes built-ins', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [jsonProbeTool(log), probeTool(log)])],
        `const results = []
         const attempt = async (setup, call) => {
           const restore = setup()
           try {
             results.push('ok: ' + (await call()))
           } catch (error) {
             results.push(error.name + ': ' + error.message)
           } finally {
             restore()
           }
         }
         // An inherited toJSON that changes its answer on a second read.
         await attempt(
           () => {
             let reads = 0
             Array.prototype.toJSON = function () { return ++reads === 1 ? ['keep'] : NaN }
             return () => { delete Array.prototype.toJSON }
           },
           () => tools.args_probe({ query: 'a', tags: ['keep'] })
         )
         // An index setter on Array.prototype.
         await attempt(
           () => {
             Object.defineProperty(Array.prototype, '0', { set() {}, configurable: true })
             return () => { delete Array.prototype[0] }
           },
           () => tools.args_probe({ query: 'a', tags: ['first'] })
         )
         // A Proxy array with a fractional length: JSON reads one item.
         await attempt(
           () => () => {},
           () => tools.json_probe({
             value: new Proxy([1, 2], {
               get: (target, key, receiver) => key === 'length' ? 1.5 : Reflect.get(target, key, receiver)
             })
           })
         )
         // A toJSON function with its own call property.
         await attempt(
           () => () => {},
           () => {
             const toJSON = () => 7
             toJSON.call = () => undefined
             return tools.args_probe({ query: 'a', limit: { toJSON } })
           }
         )
         // An invalid Date whose getTime lies.
         await attempt(
           () => () => {},
           () => {
             const since = new Date(NaN)
             since.getTime = () => 0
             return tools.json_probe({ value: since })
           }
         )
         // Number.isFinite replaced.
         await attempt(
           () => {
             const original = Number.isFinite
             Number.isFinite = () => true
             return () => { Number.isFinite = original }
           },
           () => tools.args_probe({ query: 'a', limit: NaN })
         )
         // An array iterator that hides a key.
         await attempt(
           () => {
             const original = Array.prototype[Symbol.iterator]
             Array.prototype[Symbol.iterator] = function* () {
               for (let i = 0; i < this.length; i++) if (this[i] !== 'limit') yield this[i]
             }
             return () => { Array.prototype[Symbol.iterator] = original }
           },
           () => tools.args_probe({ query: 'a', limit: 5 })
         )
         // A Proxy array with a bigint length: JSON.stringify throws a TypeError.
         await attempt(
           () => () => {},
           () => tools.json_probe({
             value: new Proxy([1, 2], {
               get: (target, key, receiver) => key === 'length' ? 1n : Reflect.get(target, key, receiver)
             })
           })
         )
         return results`
      )

      expect(result.isError).toBeUndefined()
      expect(returnValue(result)).toEqual([
        'ok: {"query":"a","tags":["keep"]}',
        'ok: {"query":"a","tags":["first"]}',
        'ok: {"value":[1]}',
        'ok: {"query":"a","limit":7}',
        'TypeError: tools.json_probe: argument at value is an invalid Date; pass a valid Date or an ISO string',
        'TypeError: tools.args_probe: argument at limit is NaN; pass a finite number or omit the key',
        'ok: {"query":"a","limit":5}',
        'TypeError: bigint argument with unary +'
      ])
      expect(log).toEqual([
        '{"query":"a","tags":["keep"]}',
        '{"query":"a","tags":["first"]}',
        '{"value":[1]}',
        '{"query":"a","limit":7}',
        '{"query":"a","limit":5}'
      ])
    })
  )

  it.live('labels calls the way scripts reach them, in the guard and in host errors', () =>
    Effect.gen(function* () {
      const result = yield* runCode(
        [
          moduleOf('host', [codemode()]),
          moduleOf('docs', [
            queryTool('123', { fail: true }),
            queryTool('a-b', { fail: true }),
            queryTool('a.b', { fail: true })
          ])
        ],
        `const messages = []
         const attempt = async call => {
           try { await call() } catch (error) { messages.push(error.message) }
         }
         await attempt(() => tools['123']({ query: NaN }))
         await attempt(() => tools._23({ query: NaN }))
         await attempt(() => tools['123']({ query: 'x' }))
         await attempt(() => tools.a_b({ query: NaN }))
         await attempt(() => tools['a-b']({ query: 'x' }))
         await attempt(() => tools['a.b']({ query: NaN }))
         await attempt(() => tools['a.b']({ query: 'x' }))
         return messages`
      )

      const nan = 'argument at query is NaN; pass a finite number or omit the key'

      expect(returnValue(result)).toEqual([
        `tools._23: ${nan}`,
        `tools._23: ${nan}`,
        'tools._23: 123 failed for x',
        `tools.a_b: ${nan}`,
        'tools.a_b: a-b failed for x',
        `tools["a.b"]: ${nan}`,
        'tools["a.b"]: a.b failed for x'
      ])
      expect(result.nestedCalls?.calls.map(call => call.name)).toEqual(['123', 'a-b', 'a.b'])
    })
  )

  it.live('rejects unknown keys with a hint naming the allowed keys, prefixed by the tool', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [probeTool(log)])],
        `try { await tools.args_probe({ query: 'a', limt: 5 }) } catch (error) { return error.message }`
      )

      const message = returnValue(result)

      expect(log).toEqual([])
      expect(message).toEqual(
        expect.stringMatching(/^tools\.args_probe: Invalid args-probe arguments/)
      )
      expect(message).toEqual(
        expect.stringContaining(
          'Unknown argument "limt". Allowed arguments: query, limit, tags, since.'
        )
      )
      // The record keeps the tool's own message, without the script-side prefix.
      expect(result.nestedCalls?.calls[0]?.error).toMatch(/^Invalid args-probe arguments/)
    })
  )

  it.live('keeps script line numbers, return, and exit() with the guarded tools', () =>
    Effect.gen(function* () {
      const modules = [moduleOf('host', [codemode()]), moduleOf('docs', [probeTool([])])]

      const thrown = yield* runCode(modules, `const a = 1\nconst b = 2\nnull.x`)

      expect(text(thrown.content)).toContain(
        "Script error: script: TypeError: cannot read property 'x' of null\n    at <anonymous> (codemode.js:3:1)\n\nTool calls"
      )

      const guarded = yield* runCode(
        modules,
        `const a = 1\nawait tools.args_probe({ query: 'a', limit: NaN })`
      )

      expect(text(guarded.content)).toMatch(
        /Script error: script: TypeError: tools\.args_probe: argument at limit is NaN; pass a finite number or omit the key\n {4}at <anonymous> \(codemode\.js:2:\d+\)\n\nTool calls/
      )

      const exited = yield* runCode(modules, `text('a'); exit(); text('b')`)

      expect(exited.isError).toBeUndefined()
      expect(text(exited.content)).toContain('Output:\na')
      expect(text(exited.content)).not.toContain('Output:\na\nb')

      const returned = yield* runCode(
        modules,
        `const value = await tools.args_probe({ query: 'r' })\nreturn { value, keys: Object.keys(tools), has: 'args_probe' in tools }`
      )

      expect(returnValue(returned)).toEqual({
        value: '{"query":"r"}',
        keys: ['args_probe', 'args-probe'],
        has: true
      })
    })
  )

  it.live('suggests close matches for unknown tools', () =>
    Effect.gen(function* () {
      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [queryTool('search_docs')])],
        `return await tools.searchdocs({ query: 'x' })`
      )

      expect(text(result.content)).toContain('Did you mean tools.search_docs?')
    })
  )

  it.live('rejects calls past maxNestedCalls without executing them', () =>
    Effect.gen(function* () {
      const log: ToolLog = []

      const result = yield* runCode(
        [
          moduleOf('host', [codemode({ limits: { maxNestedCalls: 2 } })]),
          moduleOf('docs', [queryTool('search_docs', { log })])
        ],
        `const settled = await Promise.allSettled(
           [1, 2, 3, 4].map(n => tools.search_docs({ query: String(n) }))
         )
         return settled.map(entry => entry.status === 'fulfilled' ? entry.value : entry.reason.message)`
      )

      expect(log).toEqual(['search_docs:1:tenant_1', 'search_docs:2:tenant_1'])
      expect(text(result.content)).toContain(
        '"tools.search_docs: Nested call limit reached: a script may make at most 2'
      )
      expect(result.nestedCalls?.calls.map(call => call.id)).toEqual(['call_1/1', 'call_1/2'])
    })
  )

  it.live('cancels unawaited nested calls when the script ends and records them', () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()

      const slow = makeTool<TestContext, typeof QueryParams>({
        name: 'slow',
        description: 'Never finishes',
        parameters: QueryParams,
        access: 'read',
        execute: () =>
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
      })

      const result = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [slow])],
        `tools.slow({ query: 'x' }); return 'done'`
      )

      yield* Deferred.await(interrupted).pipe(Effect.timeout('2 seconds'))

      expect(result.isError).toBeUndefined()
      expect(result.nestedCalls?.calls).toMatchObject([{ id: 'call_1/1', status: 'cancelled' }])
    })
  )

  const neverTool = (interrupted: Deferred.Deferred<void>) =>
    makeTool<TestContext, typeof QueryParams>({
      name: 'slow',
      description: 'Never finishes',
      parameters: QueryParams,
      access: 'read',
      execute: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
    })

  it.live('cancels an awaited in-flight nested call at the timeout and records it', () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()

      const result = yield* runCode(
        [
          moduleOf('host', [codemode({ limits: { timeoutMs: 1_000 } })]),
          moduleOf('docs', [neverTool(interrupted)])
        ],
        `await tools.slow({ query: 'x' }); return 'unreachable'`
      )

      yield* Deferred.await(interrupted).pipe(Effect.timeout('2 seconds'))

      expect(text(result.content)).toContain('Script error: timeout:')
      expect(result.nestedCalls?.calls).toMatchObject([{ id: 'call_1/1', status: 'cancelled' }])
    })
  )

  it.live('interrupts an awaited in-flight nested call when the tool call is aborted', () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()

      const tool = makeTool<TestContext, typeof QueryParams>({
        name: 'slow',
        description: 'Never finishes',
        parameters: QueryParams,
        access: 'read',
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
          )
      })

      const fiber = yield* runCode(
        [moduleOf('host', [codemode()]), moduleOf('docs', [tool])],
        `await tools.slow({ query: 'x' }); return 'unreachable'`
      ).pipe(Effect.forkChild)

      yield* Deferred.await(started).pipe(Effect.timeout('5 seconds'))
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(interrupted).pipe(Effect.timeout('2 seconds'))
    })
  )

  it.live('ends runaway scripts at the timeout without blocking the host', () =>
    Effect.gen(function* () {
      let ticks = 0
      const timer = setInterval(() => ticks++, 20)

      const result = yield* runCode(
        [moduleOf('host', [codemode({ limits: { timeoutMs: 600 } })])],
        `while (true) {}`
      ).pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))

      expect(result.isError).toBe(true)
      expect(text(result.content)).toContain('Script error: timeout: Execution timed out after')
      expect(ticks).toBeGreaterThan(10)
    })
  )

  it.live('stops catastrophic regular expressions at the timeout', () =>
    Effect.gen(function* () {
      const result = yield* runCode(
        [moduleOf('host', [codemode({ limits: { timeoutMs: 600 } })])],
        `return /^(a+)+$/.test('a'.repeat(40) + 'b')`
      )

      expect(text(result.content)).toContain('Script error: timeout:')
    })
  )

  it.live('caps the VM heap', () =>
    Effect.gen(function* () {
      const result = yield* runCode(
        [moduleOf('host', [codemode({ limits: { memoryLimitBytes: 8 * 1024 * 1024 } })])],
        `const chunks = []
         while (true) chunks.push('x'.repeat(1024 * 1024) + chunks.length)`
      )

      expect(result.isError).toBe(true)
      expect(text(result.content)).toMatch(/Script error: script: .*out of memory/)
    })
  )

  it.live('aborts the script when the tool call is interrupted', () =>
    Effect.gen(function* () {
      const startedAt = Date.now()

      const outcome = yield* runCode([moduleOf('host', [codemode()])], `while (true) {}`).pipe(
        Effect.timeoutOption('300 millis')
      )

      expect(Option.isNone(outcome)).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    })
  )

  it.live('strips TypeScript annotations and explains unsupported syntax', () =>
    Effect.gen(function* () {
      const modules = [moduleOf('host', [codemode()]), moduleOf('docs', [queryTool('search_docs')])]

      const typed = yield* runCode(
        modules,
        `interface Hit { id: string }
         const value: string = await tools.search_docs({ query: 'x' } as { query: string })
         const pick = (hits: Array<Hit>): string[] => hits.map(hit => hit.id)
         return { value, ids: pick([{ id: 'a' }]) satisfies string[] }`
      )

      expect(typed.isError).toBeUndefined()
      expect(text(typed.content)).toContain('{"value":"search_docs:x","ids":["a"]}')

      const enumScript = yield* runCode(modules, `enum Color { Red }\nreturn Color.Red`)

      expect(enumScript.isError).toBe(true)
      expect(text(enumScript.content)).toContain(
        'Script error: script: TypeScript enum is not supported'
      )
      expect(text(enumScript.content)).toContain('Write plain JavaScript')

      const broken = yield* runCode(modules, `const a = 1\nconst b = ;`)

      expect(text(broken.content)).toContain(
        'The script could not be parsed: Expression expected (line 2)'
      )
    })
  )

  it.live('persists store writes only for successful scripts and rebuilds the store', () =>
    Effect.gen(function* () {
      const history: Array<{ readonly toolName: string; readonly result: ToolResult }> = []

      const tool = codemode({
        loadStore: () => Effect.sync(() => codeModeStoreFromToolResults(history))
      })

      const modules = [moduleOf('host', [tool])]

      const run = (code: string, callId: string) =>
        runCode(modules, code, { callId }).pipe(
          Effect.tap(result => Effect.sync(() => history.push({ toolName: 'codemode', result })))
        )

      const first = yield* run(
        `store('count', 1); store('drop', true); return load('count')`,
        'call_a'
      )

      expect(first.structuredContent).toEqual({
        codemode: { ok: true, storeWrites: { set: { count: 1, drop: true }, delete: [] } }
      })

      const failed = yield* run(`store('count', 99); throw new Error('nope')`, 'call_b')

      expect(failed.structuredContent).toEqual({ codemode: { ok: false } })

      const second = yield* run(
        `store('drop', undefined); store('count', load('count') + 1); return load('count')`,
        'call_c'
      )

      expect(text(second.content)).toContain('Return value:\n2')
      expect(codeModeStoreFromToolResults(history)).toEqual({ count: 2 })

      const description = (yield* resolveTools(modules, context)).tools[0]?.description

      expect(description).toContain('store(key, value)')
    })
  )

  it.live(
    'rejects store writes beyond 256 KiB per value and 1 MiB in total inside the script',
    () =>
      Effect.gen(function* () {
        const result = yield* runCode(
          [moduleOf('host', [codemode()])],
          `const errors = []
         try { store('big', 'x'.repeat(256 * 1024)) } catch (error) { errors.push(error.message) }
         for (let i = 0; i < 5; i++) {
           try { store('k' + i, 'y'.repeat(250 * 1024)) } catch (error) { errors.push(error.message) }
         }
         return errors`
        )

        const body = text(result.content)

        expect(body).toContain('more than the limit of 262144')
        expect(body).toContain('store is full')
        expect(result.structuredContent).toMatchObject({
          codemode: {
            ok: true,
            storeWrites: {
              set: {
                k0: expect.any(String),
                k1: expect.any(String),
                k2: expect.any(String),
                k3: expect.any(String)
              },
              delete: []
            }
          }
        })
        expect(JSON.stringify(result.structuredContent)).not.toContain('"k4"')
        expect(JSON.stringify(result.structuredContent)).not.toContain('"big"')
      })
  )

  it.live('drops images beyond the image limits with a note', () =>
    Effect.gen(function* () {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

      const result = yield* runCode(
        [moduleOf('host', [codemode({ limits: { maxImages: 3 } })])],
        `for (let i = 0; i < 20; i++) image('data:image/png;base64,${png}')
         return 'done'`
      )

      const content = Array.isArray(result.content) ? result.content : []

      expect(content.filter(Predicate.isTagged('Image'))).toHaveLength(3)
      expect(text(result.content)).toContain(
        '[… 17 images omitted: a result keeps at most 3 images'
      )

      const bytes = yield* runCode(
        [moduleOf('host', [codemode({ limits: { maxImageBytes: png.length * 2 } })])],
        `for (let i = 0; i < 5; i++) image('data:image/png;base64,${png}')`
      )

      const byteContent = Array.isArray(bytes.content) ? bytes.content : []

      expect(byteContent.filter(Predicate.isTagged('Image'))).toHaveLength(2)
      expect(text(bytes.content)).toContain('[… 3 images omitted')
    })
  )

  it.live('bounds the model-visible output with a head and tail cut', () =>
    Effect.gen(function* () {
      const result = yield* runCode(
        [moduleOf('host', [codemode({ limits: { maxOutputChars: 1_000 } })])],
        `for (let i = 0; i < 500; i++) text('line ' + i)
         return 'the end'`
      )

      const body = text(result.content)

      expect(body.length).toBeLessThan(1_100)
      expect(body).toMatch(/^Script completed in \d+ ms\./)
      expect(body).toMatch(/\[… \d+ characters omitted …\]/)
      expect(body).toContain('line 0')
      expect(body.endsWith('Return value:\n"the end"')).toBe(true)
    })
  )

  it.live('returns images as image content parts in output order', () =>
    Effect.gen(function* () {
      const pixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

      const result = yield* runCode(
        [moduleOf('host', [codemode()])],
        `text('before'); image('data:image/png;base64,${pixel}'); text('after')`
      )

      expect(Array.isArray(result.content)).toBe(true)
      expect(Array.isArray(result.content) ? result.content.map(part => part._tag) : []).toEqual([
        'Text',
        'Image',
        'Text'
      ])
    })
  )

  it.live('exposes searchTools, describeTool, and describeNamespace over every nested tool', () =>
    Effect.gen(function* () {
      const result = yield* runCode(
        [
          moduleOf('host', [codemode()]),
          moduleOf('crm', [
            queryTool('crm-find-contact', {
              description: 'Find a CRM contact by email address',
              exposure: { callableBy: 'codemode', discovery: 'search' }
            }),
            queryTool('crm_list_deals', { description: 'List open deals' })
          ]),
          moduleOf('mail', [
            queryTool('mail_send', {
              description: 'Send an email message',
              exposure: { callableBy: 'codemode', discovery: 'search' }
            })
          ])
        ],
        `const hits = await searchTools('contact email')
         const scoped = await searchTools('email', { namespace: 'mail', limit: 1 })
         const found = await tools[hits[0].name]({ query: 'a@b.c' })
         return {
           hits: hits.map(hit => hit.name),
           scoped,
           found,
           described: await describeTool('crm-find-contact'),
           missing: await describeTool('nope') ?? null,
           namespace: await describeNamespace('crm'),
           noNamespace: await describeNamespace('nope') ?? null
         }`
      )

      const value = returnValue(result)

      expect(value).toMatchObject({
        hits: ['crm_find_contact', 'mail_send'],
        scoped: [{ name: 'mail_send', description: 'Send an email message' }],
        found: 'crm-find-contact:a@b.c',
        missing: null,
        namespace: {
          name: 'crm',
          tools: [
            { name: 'crm_find_contact', description: 'Find a CRM contact by email address' },
            { name: 'crm_list_deals', description: 'List open deals' }
          ]
        },
        noNamespace: null
      })
      expect(value).toMatchObject({
        described: expect.stringContaining('crm_find_contact(args: {')
      })
      // Globals are host helpers, not nested calls.
      expect(result.nestedCalls?.calls.map(call => call.name)).toEqual(['crm-find-contact'])
    })
  )
})

const returnValue = (result: ToolResult): unknown => {
  const body = text(result.content)
  const marker = 'Return value:\n'

  return JSON.parse(body.slice(body.indexOf(marker) + marker.length))
}

/** `[name, value]` pairs of named cases and a returned array of results in the same order. */
const zipNames = (cases: ReadonlyArray<{ readonly name: string }>, values: unknown) =>
  cases.map((entry, index): readonly [string, unknown] => [
    entry.name,
    Array.isArray(values) ? values[index] : undefined
  ])

describe('pi executor concurrency', () => {
  const until = async (condition: () => boolean) => {
    while (!condition()) await new Promise(resolve => setTimeout(resolve, 10))
  }

  const gate = () => {
    const started: Array<string> = []
    const releases = new Map<string, () => void>()

    const tool: CodeModeExecutorTool = {
      name: 'gate',
      execute: args => {
        const id = Predicate.isObject(args) && 'id' in args ? String(args.id) : ''

        started.push(id)

        return new Promise(resolve => releases.set(id, () => resolve(id)))
      }
    }

    return { started, releases, tool }
  }

  const options = (
    tool: CodeModeExecutorTool,
    signal: AbortSignal,
    timeoutMs = 10_000
  ): CodeModeExecuteOptions => ({
    tools: [tool],
    globals: [],
    timeoutMs,
    memoryLimitBytes: 64 * 1024 * 1024,
    store: {},
    signal
  })

  const script = (id: string) => `return await tools.gate({ id: '${id}' })`

  it.live('queues executions beyond the cap and hands the slot to the next waiter', () =>
    Effect.promise(async () => {
      const single = makePiCodeModeExecutor({ maxConcurrentExecutions: 1 })
      const { started, releases, tool } = gate()
      const signal = new AbortController().signal

      const first = single.execute(script('a'), options(tool, signal))

      await until(() => started.includes('a'))

      const second = single.execute(script('b'), options(tool, signal))

      await new Promise(resolve => setTimeout(resolve, 200))
      expect(started).toEqual(['a'])

      releases.get('a')?.()
      expect(await first).toMatchObject({ ok: true, value: 'a' })

      await until(() => started.includes('b'))
      releases.get('b')?.()
      expect(await second).toMatchObject({ ok: true, value: 'b' })
    })
  )

  it.live('ends waiting executions on abort and on timeout without taking the slot', () =>
    Effect.promise(async () => {
      const single = makePiCodeModeExecutor({ maxConcurrentExecutions: 1 })
      const { started, releases, tool } = gate()

      const first = single.execute(script('a'), options(tool, new AbortController().signal))

      await until(() => started.includes('a'))

      const controller = new AbortController()

      const aborted = single.execute(script('aborted'), options(tool, controller.signal))

      const timedOut = single.execute(
        script('timed_out'),
        options(tool, new AbortController().signal, 200)
      )

      controller.abort()

      expect(await aborted).toMatchObject({ ok: false, error: { kind: 'aborted' } })
      expect(await timedOut).toMatchObject({
        ok: false,
        error: {
          kind: 'timeout',
          message: 'Execution timed out after 200 ms while waiting for a free execution slot'
        }
      })

      releases.get('a')?.()
      expect(await first).toMatchObject({ ok: true, value: 'a' })

      // The slot is free again: a new execution starts at once.
      const next = single.execute(script('c'), options(tool, new AbortController().signal))

      await until(() => started.includes('c'))
      releases.get('c')?.()
      expect(await next).toMatchObject({ ok: true, value: 'c' })
      expect(started).toEqual(['a', 'c'])
    })
  )

  it.live('releases the slot when the tool call is interrupted', () =>
    Effect.gen(function* () {
      const single = makePiCodeModeExecutor({ maxConcurrentExecutions: 1 })
      const modules = [moduleOf('host', [makeCodeModeTool<TestContext>({ executor: single })])]

      const fiber = yield* runCode(modules, `while (true) {}`).pipe(Effect.forkChild)

      yield* Effect.sleep('200 millis')
      yield* Fiber.interrupt(fiber)

      const startedAt = Date.now()
      const next = yield* runCode(modules, `return 'next'`).pipe(Effect.timeout('3 seconds'))

      expect(text(next.content)).toContain('Return value:\n"next"')
      expect(Date.now() - startedAt).toBeLessThan(3_000)
    })
  )
})
