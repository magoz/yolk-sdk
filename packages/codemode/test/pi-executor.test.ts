import { Deferred, Effect, Option } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { providerToolDefs, ToolApprovalPolicy, ToolResult } from '@yolk-sdk/agent/protocol'
import { makeQuestionToolRegistration, makeTool, resolveTools } from '@yolk-sdk/agent/tools'
import { codeModeStoreFromToolResults, makeCodeModeTool } from '../src/index.ts'
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
      expect(text(result.content)).toContain('rejected: Invalid search_docs arguments')
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
      expect(body).toContain('Output:\nbefore\ncaught: broken failed for c')
      expect(body).toContain('Script error: script: TypeError: boom')
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
        'Nested call limit reached: a script may make at most 2'
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
      const history: Array<ToolResult> = []

      const tool = codemode({
        loadStore: () => Effect.sync(() => codeModeStoreFromToolResults(history))
      })

      const modules = [moduleOf('host', [tool])]

      const run = (code: string, callId: string) =>
        runCode(modules, code, { callId }).pipe(
          Effect.tap(result => Effect.sync(() => history.push(result)))
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
