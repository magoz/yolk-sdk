import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  makeInMemoryToolLedgerStore,
  makeTool,
  resolveTools,
  type NestedToolExecutor,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'

type TestContext = { readonly tenant: string }

const context: TestContext = { tenant: 'tenant_1' }

const NoteParams = Schema.Struct({ op: Schema.Literals(['get', 'set']), note: Schema.String })

const noteTool = (log: Array<string>): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof NoteParams>({
    name: 'note',
    description: 'Reads or writes a note.',
    parameters: NoteParams,
    access: 'write',
    isReadCall: params => params.op === 'get',
    execute: ({ params, context }) =>
      Effect.sync(() => {
        log.push(`${params.op}:${params.note}:${context.tenant}`)

        return { content: `${params.op}:${params.note}` }
      })
  })

const modelTool = makeTool<TestContext, typeof NoteParams>({
  name: 'summarize',
  description: 'Summarizes with a model.',
  parameters: NoteParams,
  access: 'read',
  invokesModel: true,
  execute: () => Effect.succeed({ content: 'summary' })
})

const rawModelTool: ToolRegistration<TestContext> = {
  def: ToolDef.make({
    name: 'raw_model',
    description: 'Raw registration that calls a model.',
    parameters: { type: 'object', properties: {} }
  }),
  access: 'read',
  invokesModel: true,
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
}

/** A nested-access registration that hands out its `nested` executor. */
const capturingNested = (seen: Array<NestedToolExecutor>): ToolRegistration<TestContext> => ({
  def: ToolDef.make({
    name: 'script',
    description: 'Captures nested access.',
    parameters: { type: 'object', properties: {} }
  }),
  access: 'write',
  nestedToolAccess: true,
  execute: ({ call, nested }) =>
    Effect.sync(() => {
      if (nested !== undefined) seen.push(nested)

      return ToolResult.make({ toolCallId: call.id, content: 'ok' })
    })
})

const modules = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ReadonlyArray<ToolModule<TestContext>> => [{ id: 'host', tools }]

describe('invokesModel', () => {
  it.effect('is copied to tool metadata and nested tools, and absent otherwise', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(modules([noteTool([]), modelTool, rawModelTool]), context)

      expect(toolSet.metadata).toEqual([
        { moduleId: 'host', name: 'note', access: 'write' },
        { moduleId: 'host', name: 'summarize', access: 'read', invokesModel: true },
        { moduleId: 'host', name: 'raw_model', access: 'read', invokesModel: true }
      ])

      const nested = toolSet.nestedExecutor({ parentCallId: 'check_1' })

      expect(nested.tools.map(tool => [tool.def.name, tool.invokesModel])).toEqual([
        ['note', undefined],
        ['summarize', true],
        ['raw_model', true]
      ])
      expect(nested.tools.every(tool => !('invokesModel' in tool.def))).toBe(true)
    })
  )
})

describe('ResolvedToolSet.nestedExecutor', () => {
  it.effect('lists the same tools a nested-access registration gets', () =>
    Effect.gen(function* () {
      const seen: Array<NestedToolExecutor> = []

      const toolSet = yield* resolveTools(
        modules([noteTool([]), modelTool, capturingNested(seen)]),
        context
      )

      yield* toolSet.execute(ToolCall.make({ id: 'call_1', name: 'script', params: {} }))

      expect(toolSet.nestedExecutor({ parentCallId: 'check_1' }).tools).toEqual(seen[0]?.tools)
    })
  )

  it.effect('runs calls through decoding with the host context and effective access', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const toolSet = yield* resolveTools(modules([noteTool(log)]), context)
      const nested = toolSet.nestedExecutor({ parentCallId: 'check_1' })

      const read = ToolCall.make({
        id: 'check_1/1',
        name: 'note',
        params: { op: 'get', note: 'a' }
      })

      const invalid = ToolCall.make({ id: 'check_1/2', name: 'note', params: { op: 'drop' } })
      const unknown = ToolCall.make({ id: 'check_1/3', name: 'missing', params: {} })

      expect(yield* nested.access(read)).toBe('read')
      expect(
        yield* nested.access(
          ToolCall.make({ id: 'check_1/4', name: 'note', params: { op: 'set', note: 'b' } })
        )
      ).toBe('write')
      expect(yield* nested.access(unknown)).toBeUndefined()

      expect((yield* nested.execute(read)).content).toBe('get:a')
      expect((yield* nested.execute(invalid)).isError).toBe(true)
      expect((yield* nested.execute(unknown)).isError).toBe(true)
      expect(log).toEqual(['get:a:tenant_1'])
    })
  )

  it.effect('ledgers nested writes under the host parent call id', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const store = makeInMemoryToolLedgerStore({ scope: 'run_1' })
      const write = { op: 'set', note: 'b' }

      const run = Effect.gen(function* () {
        const toolSet = yield* resolveTools(modules([noteTool(log)]), context, {
          ledger: { store }
        })

        return yield* toolSet
          .nestedExecutor({ parentCallId: 'check_1' })
          .execute(ToolCall.make({ id: 'check_1/1', name: 'note', params: write }))
      })

      const first = yield* run
      const replayed = yield* run

      expect(replayed.content).toEqual(first.content)
      expect(log).toEqual(['set:b:tenant_1'])
      expect((yield* store.list('check_1')).map(entry => entry.key)).toEqual(['check_1/1'])
    })
  )
})
