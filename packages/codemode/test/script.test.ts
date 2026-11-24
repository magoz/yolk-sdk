import { Deferred, Effect, Fiber } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolApprovalPolicy, ToolCall } from '@yolk-sdk/agent/protocol'
import { makeTool, resolveTools, type ToolRegistration } from '@yolk-sdk/agent/tools'
import {
  CodeModeNestedCallRefused,
  makeClassifierTool,
  makeCodeModeTool,
  readOnlyNestedCallGate,
  runCodeModeScript,
  type CodeModeExecuteOptions,
  type CodeModeExecutionResult,
  type CodeModeExecutor
} from '../src/index.ts'
import { makePiCodeModeExecutor } from '../src/node.ts'
import {
  context,
  moduleOf,
  QueryParams,
  queryTool,
  runCode,
  text,
  type TestContext,
  type ToolLog
} from './fixtures.ts'

const callingExecutor = (
  script: (options: CodeModeExecuteOptions) => Promise<CodeModeExecutionResult>
): CodeModeExecutor => ({ execute: (_code, options) => script(options) })

const call = (options: CodeModeExecuteOptions, name: string, args: unknown) => {
  const tool = options.tools.find(candidate => candidate.name === name)

  return tool === undefined
    ? Promise.reject(new Error(`no tool ${name}`))
    : tool.execute(args, { signal: options.signal })
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : '',
      code: error instanceof Error && 'code' in error ? error.code : undefined
    })
  )

const RecordParams = Schema.Struct({ op: Schema.Literals(['get', 'set']), value: Schema.String })

/** A `write` tool whose `get` calls only read (`isReadCall`). */
const recordTool = (log: ToolLog): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof RecordParams>({
    name: 'record',
    description: 'Reads or writes a record.',
    parameters: RecordParams,
    access: 'write',
    isReadCall: params => params.op === 'get',
    execute: ({ params }) =>
      Effect.sync(() => {
        log.push(`record:${params.op}:${params.value}`)

        return { content: `${params.op}:${params.value}` }
      })
  })

const classifier = makeClassifierTool<TestContext>({
  classify: () =>
    Effect.succeed({
      model: 'synthetic/classifier',
      answers: { yes: { type: 'boolean', probability: 0.9 } }
    })
})

const hostToolSet = (log: ToolLog) =>
  resolveTools(
    [
      moduleOf('docs', [queryTool('lookup', { log })]),
      moduleOf('records', [recordTool(log)]),
      moduleOf('models', [classifier])
    ],
    context
  )

describe('runCodeModeScript', () => {
  it.effect('runs a script over a host nested executor and returns structured data', () =>
    Effect.gen(function* () {
      const log: ToolLog = []
      const toolSet = yield* hostToolSet(log)

      const executor = callingExecutor(async options => ({
        ok: true,
        value: {
          found: await call(options, 'lookup', { query: 'a' }),
          read: await call(options, 'record', { op: 'get', value: 'x' })
        },
        output: [{ type: 'text', text: 'checked' }],
        storeWrites: { set: { cursor: 2 }, delete: [] }
      }))

      const result = yield* runCodeModeScript({
        executor,
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1',
        store: { cursor: 1 }
      })

      expect(result.ok).toBe(true)
      expect(result.ok && result.value).toEqual({ found: 'lookup:a', read: 'get:x' })
      expect(result.ok && result.storeWrites).toEqual({ set: { cursor: 2 }, delete: [] })
      expect(result.output).toEqual([{ type: 'text', text: 'checked' }])
      expect(result.calls).toMatchObject([
        { id: 'check_1/1', name: 'lookup', status: 'ok', access: 'read' },
        { id: 'check_1/2', name: 'record', status: 'ok', access: 'read' }
      ])
      expect(result.nestedCalls.calls.map(entry => entry.id)).toEqual(['check_1/1', 'check_1/2'])
      expect(result.staged).toBeUndefined()
      expect(log).toEqual(['lookup:a:tenant_1', 'record:get:x'])
    })
  )

  it.effect('passes the store, limits and the deadline clamp to the executor', () =>
    Effect.gen(function* () {
      const toolSet = yield* hostToolSet([])
      const seen: Array<CodeModeExecuteOptions> = []

      const executor = callingExecutor(options => {
        seen.push(options)

        return Promise.resolve({ ok: true, output: [] })
      })

      // The test clock starts at epoch 0.
      const result = yield* runCodeModeScript({
        executor,
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1',
        limits: { timeoutMs: 60_000, memoryLimitBytes: 1024 },
        deadline: 20_000,
        store: { state: { seen: 1 } }
      })

      expect(seen[0]?.timeoutMs).toBe(15_000)
      expect(seen[0]?.memoryLimitBytes).toBe(1024)
      expect(seen[0]?.store).toEqual({ state: { seen: 1 } })
      expect(result.timeoutMs).toBe(15_000)
      expect(result).toMatchObject({ ok: true, calls: [] })
      expect('value' in result).toBe(false)
    })
  )

  it.effect('reports a failed script with its error and keeps its output and calls', () =>
    Effect.gen(function* () {
      const toolSet = yield* hostToolSet([])

      const executor = callingExecutor(async options => {
        await call(options, 'lookup', { query: 'a' })

        return {
          ok: false,
          error: { kind: 'script', message: 'Error: boom' },
          output: [{ type: 'text', text: 'partial' }]
        }
      })

      const result = yield* runCodeModeScript({
        executor,
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1'
      })

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'script', message: 'Error: boom' },
        output: [{ type: 'text', text: 'partial' }],
        calls: [{ id: 'check_1/1', status: 'ok' }]
      })
      expect('storeWrites' in result).toBe(false)
    })
  )

  it.effect('records coded and plain refusals without running the call', () =>
    Effect.gen(function* () {
      const log: ToolLog = []
      const toolSet = yield* hostToolSet(log)

      const executor = callingExecutor(async options => ({
        ok: true,
        value: [
          await settle(call(options, 'lookup', { query: 'coded' })),
          await settle(call(options, 'lookup', { query: 'plain' }))
        ],
        output: []
      }))

      const result = yield* runCodeModeScript({
        executor,
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1',
        beforeNestedCall: ({ call: nestedCall, tool, access }) =>
          JSON.stringify(nestedCall.params).includes('coded')
            ? Effect.fail(
                new CodeModeNestedCallRefused({
                  code: 'host_policy',
                  message: `${tool.def.name} (${access}) is off limits.`
                })
              )
            : Effect.fail('Not now.')
      })

      expect(result.ok && result.value).toEqual([
        { ok: false, message: 'tools.lookup: lookup (read) is off limits.', code: 'host_policy' },
        { ok: false, message: 'tools.lookup: Not now.', code: undefined }
      ])
      expect(result.calls).toMatchObject([
        {
          id: 'check_1/1',
          status: 'error',
          error: 'lookup (read) is off limits.',
          refusal: { code: 'host_policy', message: 'lookup (read) is off limits.' }
        },
        { id: 'check_1/2', status: 'error', refusal: { message: 'Not now.' } }
      ])
      expect(result.calls[1]?.refusal).toEqual({ message: 'Not now.' })
      expect(log).toEqual([])
    })
  )

  it.effect('reports admitted calls to afterNestedCall, never refused ones', () =>
    Effect.gen(function* () {
      const toolSet = yield* hostToolSet([])
      const settled: Array<string> = []

      const executor = callingExecutor(async options => {
        await settle(call(options, 'lookup', { query: 'a' }))
        await settle(call(options, 'record', { op: 'set', value: 'x' }))

        return { ok: true, output: [] }
      })

      yield* runCodeModeScript({
        executor,
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1',
        beforeNestedCall: readOnlyNestedCallGate(),
        afterNestedCall: ({ call: nestedCall, outcome }) =>
          Effect.sync(() => {
            settled.push(`${nestedCall.id}:${outcome}`)
          })
      })

      expect(settled).toEqual(['check_1/1:success'])
    })
  )

  it.effect('interrupting the run aborts the script and cancels running nested calls', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let nestedInterrupted = false
      let scriptSignal: AbortSignal | undefined

      const slow = makeTool<TestContext, typeof QueryParams>({
        name: 'slow',
        description: 'Never finishes.',
        parameters: QueryParams,
        access: 'read',
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                nestedInterrupted = true
              })
            )
          )
      })

      const toolSet = yield* resolveTools([moduleOf('slow', [slow])], context)

      const executor = callingExecutor(options => {
        scriptSignal = options.signal

        return settle(call(options, 'slow', { query: 'x' })).then(() => ({
          ok: false,
          error: { kind: 'aborted', message: 'aborted' },
          output: []
        }))
      })

      const fiber = yield* runCodeModeScript({
        executor,
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1'
      }).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      expect(scriptSignal?.aborted).toBe(true)
      expect(nestedInterrupted).toBe(true)
    })
  )

  it.effect('never offers staging on a host nested executor', () =>
    Effect.gen(function* () {
      const toolSet = yield* hostToolSet([])

      expect(toolSet.nestedExecutor({ parentCallId: 'check_1' }).staging).toBeUndefined()
    })
  )
})

describe('readOnlyNestedCallGate', () => {
  const gated = (
    script: (options: CodeModeExecuteOptions) => Promise<unknown>,
    gate = readOnlyNestedCallGate()
  ) =>
    Effect.gen(function* () {
      const log: ToolLog = []
      const toolSet = yield* hostToolSet(log)

      const result = yield* runCodeModeScript({
        executor: callingExecutor(async options => ({
          ok: true,
          value: await script(options),
          output: []
        })),
        code: 'ignored',
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1',
        beforeNestedCall: gate
      })

      return { result, log }
    })

  it.effect('admits reads, including read-only calls of write tools', () =>
    Effect.gen(function* () {
      const { result, log } = yield* gated(async options => [
        await call(options, 'lookup', { query: 'a' }),
        await call(options, 'record', { op: 'get', value: 'x' })
      ])

      expect(result.ok && result.value).toEqual(['lookup:a', 'get:x'])
      expect(result.calls.every(entry => entry.refusal === undefined)).toBe(true)
      expect(log).toEqual(['lookup:a:tenant_1', 'record:get:x'])
    })
  )

  it.effect('refuses writes and tools that invoke a model with machine-readable codes', () =>
    Effect.gen(function* () {
      const { result, log } = yield* gated(async options => [
        await settle(call(options, 'record', { op: 'set', value: 'x' })),
        await settle(call(options, 'classify', { state: 'x', questions: {} }))
      ])

      expect(result.ok && result.value).toEqual([
        {
          ok: false,
          message: 'tools.record: record is not a read: this script may only call tools that read.',
          code: 'not_read'
        },
        {
          ok: false,
          message:
            'tools.classify: classify calls a model: this script may only call tools that read without one.',
          code: 'invokes_model'
        }
      ])
      expect(result.calls.map(entry => entry.refusal?.code)).toEqual(['not_read', 'invokes_model'])
      expect(log).toEqual([])
    })
  )

  it.effect('lets the host admit a write it vouches for, never a model call', () =>
    Effect.gen(function* () {
      const { result, log } = yield* gated(
        async options => [
          await settle(call(options, 'record', { op: 'set', value: 'x' })),
          await settle(call(options, 'classify', { state: 'x', questions: {} }))
        ],
        readOnlyNestedCallGate({ admit: () => true })
      )

      expect(result.calls.map(entry => entry.refusal?.code)).toEqual([undefined, 'invokes_model'])
      expect(log).toEqual(['record:set:x'])
    })
  )

  it.effect('fails closed for tools without access and approval-gated tools', () =>
    Effect.gen(function* () {
      const gate = readOnlyNestedCallGate({ admit: () => true })
      const toolSet = yield* hostToolSet([])
      const lookup = toolSet.nestedExecutor({ parentCallId: 'p' }).tools[0]

      expect(lookup?.def.name).toBe('lookup')

      if (lookup === undefined) return

      const unavailable = yield* gate({
        call: ToolCall.make({ id: 'p/1', name: 'lookup', params: {} }),
        tool: lookup,
        access: undefined
      }).pipe(Effect.flip)

      // `nested.tools` never lists approval-gated tools; the gate refuses them anyway.
      const gatedTool = makeTool<TestContext, typeof QueryParams>({
        name: 'gated',
        description: 'Approval-gated read.',
        parameters: QueryParams,
        access: 'read',
        approval: ToolApprovalPolicy.make({ mode: 'manual' }),
        execute: () => Effect.succeed({ content: 'never' })
      })

      const approval = yield* gate({
        call: ToolCall.make({ id: 'p/2', name: 'gated', params: {} }),
        tool: { def: gatedTool.def, moduleId: 'gated' },
        access: 'read'
      }).pipe(Effect.flip)

      expect([unavailable.code, approval.code]).toEqual(['unavailable', 'approval_required'])
    })
  )
})

describe('makeCodeModeTool over runCodeModeScript', () => {
  it.effect('passes the tool, its access and the context to beforeNestedCall', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []

      const executor = callingExecutor(async options => ({
        ok: true,
        value: await settle(call(options, 'record', { op: 'set', value: 'x' })),
        output: []
      }))

      const result = yield* runCode(
        [
          moduleOf('host', [
            makeCodeModeTool<TestContext>({
              executor,
              beforeNestedCall: input =>
                Effect.suspend(() => {
                  seen.push(
                    `${input.call.id}:${input.tool.moduleId}:${input.access}:${input.context.tenant}`
                  )

                  return readOnlyNestedCallGate()(input)
                })
            })
          ]),
          moduleOf('records', [recordTool([])])
        ],
        'ignored'
      )

      expect(seen).toEqual(['call_1/1:records:write:tenant_1'])
      expect(text(result.content)).toContain('"code":"not_read"')
      expect(result.nestedCalls?.calls[0]).toMatchObject({ status: 'error', access: 'write' })
      // The return value stays model-visible text; structuredContent keeps its shape.
      expect(result.structuredContent).toEqual({ codemode: { ok: true } })
    })
  )
})

describe('runCodeModeScript with the pi executor', () => {
  const executor = makePiCodeModeExecutor()

  it.live('runs a host check end to end, refusing a write the script catches', () =>
    Effect.gen(function* () {
      const log: ToolLog = []
      const toolSet = yield* hostToolSet(log)

      const result = yield* runCodeModeScript({
        executor,
        code: [
          'const state = load("state") ?? { seen: 0 }',
          'const found = await tools.lookup({ query: "a" })',
          'let refused',
          'try { await tools.record({ op: "set", value: "x" }) } catch (error) { refused = error.code }',
          'console.log("checked")',
          'return { wake: found === "lookup:a", refused, state: { seen: state.seen + 1 } }'
        ].join('\n'),
        nested: toolSet.nestedExecutor({ parentCallId: 'check_1' }),
        parentCallId: 'check_1',
        store: { state: { seen: 1 } },
        beforeNestedCall: readOnlyNestedCallGate()
      })

      expect(result).toMatchObject({
        ok: true,
        value: { wake: true, refused: 'not_read', state: { seen: 2 } },
        output: [{ type: 'text', text: 'checked' }]
      })
      expect(result.calls.map(entry => [entry.id, entry.status, entry.refusal?.code])).toEqual([
        ['check_1/1', 'ok', undefined],
        ['check_1/2', 'error', 'not_read']
      ])
      expect(log).toEqual(['lookup:a:tenant_1'])
    })
  )
})
