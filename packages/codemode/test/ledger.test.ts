import { type Duration, Effect, Fiber, Logger } from 'effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from '@effect/vitest'
import {
  nestedToolCallMaxArgsBytes,
  nestedToolCallMaxTotalArgsBytes,
  ToolCall,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  makeInMemoryToolLedgerStore,
  makeTool,
  resolveTools,
  toolLedgerArgs,
  ToolLedgerError,
  ToolLedgerFailed,
  ToolLedgerSucceeded,
  type ToolLedgerArgs,
  type ToolLedgerOptions,
  type ToolLedgerStore,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import {
  makeCodeModeTool,
  type CodeModeAfterNestedCallInput,
  type CodeModeExecutor,
  type CodeModeInterruptedCalls,
  type MakeCodeModeToolOptions
} from '../src/index.ts'
import { context, moduleOf, queryTool, text, type TestContext } from './fixtures.ts'

type CallTool = (name: string, args?: unknown) => Promise<unknown>

/** A fake engine running a host-side script over the executor's tools. */
const scriptedExecutor = (script: (call: CallTool) => Promise<unknown>) => {
  const state = { runs: 0 }

  const executor: CodeModeExecutor = {
    execute: (_code, options) => {
      state.runs++

      const call: CallTool = (name, args) => {
        const tool = options.tools.find(candidate => candidate.name === name)

        return tool === undefined
          ? Promise.reject(new Error(`unknown tool ${name}`))
          : tool.execute(args, { signal: options.signal })
      }

      return script(call).then(
        value => ({ ok: true, value, output: [] }),
        (error: unknown) => ({
          ok: false,
          error: { kind: 'script', message: String(error) },
          output: []
        })
      )
    }
  }

  return { executor, state }
}

const NoteParams = Schema.Struct({ note: Schema.String })

type WriteLog = Array<{ readonly note: string; readonly key: string | undefined }>

/** `sales_manage`: a write tool that logs each execution; `block` never finishes, `sleep` waits. */
const salesManage = (
  log: WriteLog,
  options: { readonly block?: string; readonly sleep?: Duration.Input } = {}
): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof NoteParams>({
    name: 'sales_manage',
    description: 'Append a note to a deal',
    parameters: NoteParams,
    access: 'write',
    execute: ({ call, params, idempotencyKey }) =>
      Effect.gen(function* () {
        log.push({ note: params.note, key: idempotencyKey })

        if (params.note === options.block) return yield* Effect.never

        if (options.sleep !== undefined) yield* Effect.sleep(options.sleep)

        return ToolResult.make({ toolCallId: call.id, content: `noted ${params.note}` })
      })
  })

const runLedgered = (
  modules: ReadonlyArray<ToolModule<TestContext>>,
  ledger: ToolLedgerOptions,
  callId = 'call_1'
) =>
  Effect.gen(function* () {
    const toolSet = yield* resolveTools(modules, context, { ledger })

    return yield* toolSet.execute(
      ToolCall.make({ id: callId, name: 'codemode', params: { code: 'script' } })
    )
  })

const codeModeModules = (
  executor: CodeModeExecutor,
  tools: ReadonlyArray<ToolRegistration<TestContext>>,
  options: Partial<MakeCodeModeToolOptions<TestContext>> = {}
) => [
  moduleOf('host', [makeCodeModeTool<TestContext>({ ...options, executor })]),
  moduleOf('crm', tools)
]

// Real event-loop turns let promise-based scripts progress while the test clock stands still.
const waitUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1_000 && !condition(); turn++) {
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 1)))
    }

    expect(condition()).toBe(true)
  })

// The documented `interruptedCalls` shape, decoded to prove the result is plain wire data.
const InterruptedContent = Schema.Struct({
  codemode: Schema.Struct({
    ok: Schema.Literal(false),
    interrupted: Schema.Literal(true),
    interruptedCalls: Schema.Struct({
      calls: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          toolName: Schema.String,
          args: Schema.String,
          status: Schema.Literals(['applied', 'failed', 'unknown'])
        })
      ),
      complete: Schema.Boolean,
      counts: Schema.Struct({
        applied: Schema.Number,
        failed: Schema.Number,
        unknown: Schema.Number
      })
    })
  })
})

describe('code mode with a tool ledger', () => {
  it.effect('never re-runs a crashed script and reports its applied and unknown writes', () =>
    Effect.gen(function* () {
      const log: WriteLog = []
      const store = makeInMemoryToolLedgerStore({ scope: 'wrun_1' })

      const { executor, state } = scriptedExecutor(async call => {
        await call('sales_manage', { note: 'first' })
        await call('lookup', { query: 'deal' })
        await call('sales_manage', { note: 'second' })

        return 'done'
      })

      const modules = codeModeModules(executor, [
        salesManage(log, { block: 'second' }),
        queryTool('lookup')
      ])

      const crashed = yield* Effect.forkChild(runLedgered(modules, { store }))

      yield* waitUntil(() => log.length === 2)
      // The process dies while the second write runs: nothing records an outcome for it.
      yield* Fiber.interrupt(crashed)
      yield* TestClock.adjust('1 minute')

      const result = yield* runLedgered(modules, { store })
      const content = text(result.content)

      expect(state.runs).toBe(1)
      expect(log).toEqual([
        { note: 'first', key: 'wrun_1:call_1/1' },
        { note: 'second', key: 'wrun_1:call_1/3' }
      ])
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({
        codemode: {
          ok: false,
          interrupted: true,
          interruptedCalls: {
            calls: [
              {
                key: 'call_1/1',
                toolName: 'sales_manage',
                args: '{"note":"first"}',
                status: 'applied'
              },
              {
                key: 'call_1/3',
                toolName: 'sales_manage',
                args: '{"note":"second"}',
                status: 'unknown'
              }
            ],
            complete: true,
            counts: { applied: 1, failed: 0, unknown: 1 }
          }
        }
      })
      expect(content).toContain(
        'Script interrupted: an earlier execution of this codemode call (call_1) started but never recorded a result. The script was not run again.'
      )
      expect(content).toContain('(they were not undone)')
      expect(content).toContain('- call_1/1 sales_manage {"note":"first"}: applied')
      expect(content).toContain(
        '- call_1/3 sales_manage {"note":"second"}: unknown: it started but never recorded a result, so it may have been applied'
      )
      // Reads are not ledgered and not listed.
      expect(content).not.toContain('call_1/2')

      // A third execution reads the same abandoned entry: still nothing runs.
      yield* runLedgered(modules, { store })
      expect(state.runs).toBe(1)
      expect(log).toHaveLength(2)
    })
  )

  it.effect('keeps the interrupted warning when the nested calls cannot be listed', () =>
    Effect.gen(function* () {
      const log: WriteLog = []
      const memory = makeInMemoryToolLedgerStore()

      const { executor, state } = scriptedExecutor(async call => {
        await call('sales_manage', { note: 'first' })
        await call('sales_manage', { note: 'second' })

        return 'done'
      })

      const modules = codeModeModules(executor, [salesManage(log, { block: 'second' })])
      const crashed = yield* Effect.forkChild(runLedgered(modules, { store: memory }))

      yield* waitUntil(() => log.length === 2)
      yield* Fiber.interrupt(crashed)
      yield* TestClock.adjust('1 minute')

      const store: ToolLedgerStore = {
        ...memory,
        list: () => Effect.fail(new ToolLedgerError({ message: 'replica lagging' }))
      }

      const result = yield* runLedgered(modules, { store })
      const content = text(result.content)

      expect(state.runs).toBe(1)
      expect(log).toHaveLength(2)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({
        codemode: { ok: false, interrupted: true, interruptedCallsUnavailable: true }
      })
      expect(content).toContain('The script was not run again.')
      expect(content).toContain('could not be listed')
      expect(content).toContain('may already have been applied')
      expect(content).toContain('Verify the state')
      expect(content).not.toContain('No ledgered nested tool calls')
    })
  )

  it.effect('bounds the interrupted calls in structuredContent like nestedCalls', () =>
    Effect.gen(function* () {
      const store = makeInMemoryToolLedgerStore()
      const { executor, state } = scriptedExecutor(async () => 'never runs')
      const modules = codeModeModules(executor, [], { limits: { maxNestedCalls: 5 } })

      const lease = { nowMs: 0, leaseExpiresAtMs: 1_000, leaseMs: 1_000 }

      const claimNested = (key: string, args: ToolLedgerArgs) =>
        store.claim({ key, parentKey: 'call_1', toolName: 'sales_manage', ...args, ...lease })

      // An abandoned script with six ledgered nested writes: big arguments, mixed outcomes.
      yield* store.claim({
        key: 'call_1',
        toolName: 'codemode',
        ...toolLedgerArgs({ code: 'script' }),
        ...lease
      })

      for (let seq = 1; seq <= 6; seq++) {
        const key = `call_1/${seq}`

        yield* claimNested(key, toolLedgerArgs({ note: 'é'.repeat(5_000) }))

        if (seq === 1) {
          yield* store.complete({
            key,
            completedAtMs: 1,
            outcome: ToolLedgerSucceeded.make({
              result: ToolResult.make({ toolCallId: key, content: 'noted' })
            })
          })
        }

        if (seq === 2) {
          yield* store.complete({
            key,
            completedAtMs: 1,
            outcome: ToolLedgerFailed.make({
              error: { tool: 'sales_manage', cause: 'execution', message: 'rejected' }
            })
          })
        }
      }

      yield* TestClock.adjust('2 seconds')

      const result = yield* runLedgered(modules, { store })

      const structured = yield* Schema.decodeUnknownEffect(InterruptedContent)(
        result.structuredContent
      )

      // The decoded shape is assignable to the exported type.
      const interrupted: CodeModeInterruptedCalls = structured.codemode.interruptedCalls

      expect(state.runs).toBe(0)
      expect(structured.codemode).toMatchObject({ ok: false, interrupted: true })
      expect(interrupted.complete).toBe(false)
      expect(interrupted.counts).toEqual({ applied: 1, failed: 1, unknown: 4 })
      expect(interrupted.calls.map(call => [call.key, call.status])).toEqual([
        ['call_1/1', 'applied'],
        ['call_1/2', 'failed'],
        ['call_1/3', 'unknown'],
        ['call_1/4', 'unknown'],
        ['call_1/5', 'unknown']
      ])

      const argsBytes = (interrupted.calls ?? []).map(
        call => new TextEncoder().encode(call.args).length
      )

      expect(Math.max(...argsBytes)).toBeLessThanOrEqual(nestedToolCallMaxArgsBytes)
      expect(argsBytes.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(
        nestedToolCallMaxTotalArgsBytes
      )
      // Plain JSON: survives a JSON round trip unchanged.
      expect(JSON.parse(JSON.stringify(result.structuredContent))).toEqual(result.structuredContent)
      expect(text(result.content)).toContain('- call_1/2 sales_manage')
    })
  )

  it.effect('marks interrupted calls incomplete when the ledger already cut their arguments', () =>
    Effect.gen(function* () {
      const log: WriteLog = []
      const store = makeInMemoryToolLedgerStore()
      const note = 'n'.repeat(nestedToolCallMaxArgsBytes + 1_000)

      const { executor } = scriptedExecutor(async call => {
        await call('sales_manage', { note })

        return 'done'
      })

      const modules = codeModeModules(executor, [salesManage(log, { block: note })])
      const crashed = yield* Effect.forkChild(runLedgered(modules, { store }))

      yield* waitUntil(() => log.length === 1)
      yield* Fiber.interrupt(crashed)
      yield* TestClock.adjust('1 minute')

      const result = yield* runLedgered(modules, { store })

      const structured = yield* Schema.decodeUnknownEffect(InterruptedContent)(
        result.structuredContent
      )

      const [entry] = structured.codemode.interruptedCalls.calls

      // One call, within the per-call and total budgets here, but cut when it was claimed.
      expect(structured.codemode.interruptedCalls.calls).toHaveLength(1)
      expect(entry?.args.endsWith('…')).toBe(true)
      expect(structured.codemode.interruptedCalls.complete).toBe(false)
    })
  )

  it.effect('reports a different long script under the same call id as a conflict', () =>
    Effect.gen(function* () {
      const log: WriteLog = []
      const store = makeInMemoryToolLedgerStore()

      const { executor, state } = scriptedExecutor(async call => {
        await call('sales_manage', { note: 'once' })

        return 'done'
      })

      const modules = codeModeModules(executor, [salesManage(log)])
      const prefix = `// ${'x'.repeat(9 * 1024)}\n`

      const run = (code: string) =>
        Effect.gen(function* () {
          const toolSet = yield* resolveTools(modules, context, { ledger: { store } })

          return yield* toolSet.execute(
            ToolCall.make({ id: 'call_1', name: 'codemode', params: { code } })
          )
        })

      const first = yield* run(`${prefix}await sales_manage({ note: 'a' })`)
      const second = yield* run(`${prefix}await sales_manage({ note: 'b' })`)

      expect(first.isError).toBeUndefined()
      expect(state.runs).toBe(1)
      expect(log).toHaveLength(1)
      expect(second.isError).toBe(true)
      expect(second.structuredContent).toMatchObject({ details: { state: 'conflict' } })
    })
  )

  it.effect('returns the stored result of a completed script without running it', () =>
    Effect.gen(function* () {
      const log: WriteLog = []
      const store = makeInMemoryToolLedgerStore()

      const { executor, state } = scriptedExecutor(async call => {
        await call('sales_manage', { note: 'once' })

        return { ok: true }
      })

      const modules = codeModeModules(executor, [salesManage(log)])
      const first = yield* runLedgered(modules, { store })
      const second = yield* runLedgered(modules, { store })

      expect(state.runs).toBe(1)
      expect(log.map(entry => entry.note)).toEqual(['once'])
      expect(second).toEqual(first)
      expect(second.nestedCalls?.calls.map(call => call.id)).toEqual(['call_1/1'])
    })
  )

  it.live('makes a concurrent duplicate wait for the running script', () =>
    Effect.gen(function* () {
      const log: WriteLog = []
      const store = makeInMemoryToolLedgerStore()

      const { executor, state } = scriptedExecutor(async call => {
        await call('sales_manage', { note: 'classified hot' })

        return 'done'
      })

      const modules = codeModeModules(executor, [salesManage(log, { sleep: '150 millis' })])
      const ledger: ToolLedgerOptions = { store, pollIntervalMs: 10 }
      const first = yield* Effect.forkChild(runLedgered(modules, ledger))

      yield* waitUntil(() => log.length === 1)

      const second = yield* Effect.forkChild(runLedgered(modules, ledger))
      const firstResult = yield* Fiber.join(first)
      const secondResult = yield* Fiber.join(second)

      expect(state.runs).toBe(1)
      expect(log).toHaveLength(1)
      expect(secondResult).toEqual(firstResult)
      expect(firstResult.isError).toBeUndefined()
    })
  )
})

describe('code mode nested-call record and hooks', () => {
  it.effect('records more than 256 calls when maxNestedCalls allows them', () =>
    Effect.gen(function* () {
      const { executor } = scriptedExecutor(async call => {
        for (let index = 0; index < 700; index++) {
          await call('lookup', { query: `q${index}` })
        }

        return 'done'
      })

      const toolSet = yield* resolveTools(
        codeModeModules(executor, [queryTool('lookup')], { limits: { maxNestedCalls: 768 } }),
        context
      )

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'codemode', params: { code: 'script' } })
      )

      expect(result.isError).toBeUndefined()
      expect(result.nestedCalls?.calls).toHaveLength(700)
      expect(result.nestedCalls?.calls.at(-1)?.id).toBe('call_1/700')
      expect(result.nestedCalls?.counts).toEqual({ ok: 700, error: 0, cancelled: 0 })
      expect(result.nestedCalls?.complete).toBe(true)
    })
  )

  it.effect('never lets a failing afterNestedCall change the nested result', () =>
    Effect.gen(function* () {
      const settled: Array<unknown> = []

      const { executor } = scriptedExecutor(async call => {
        settled.push(await call('lookup', { query: 'a' }))

        return 'done'
      })

      const modules = codeModeModules(executor, [queryTool('lookup')], {
        afterNestedCall: () => Effect.die('metrics exporter crashed')
      })

      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])
      const toolSet = yield* resolveTools(modules, context)

      const result = yield* toolSet
        .execute(ToolCall.make({ id: 'call_1', name: 'codemode', params: { code: 'script' } }))
        .pipe(Effect.provide(logger))

      expect(result.isError).toBeUndefined()
      expect(settled).toEqual(['lookup:a'])
      expect(result.nestedCalls?.counts).toEqual({ ok: 1, error: 0, cancelled: 0 })
      expect(messages).toContainEqual([
        expect.stringContaining('afterNestedCall failed for call_1/1')
      ])
    })
  )

  it.effect('never lets an afterNestedCall that throws synchronously change the result', () =>
    Effect.gen(function* () {
      const settled: Array<unknown> = []

      const { executor } = scriptedExecutor(async call => {
        settled.push(await call('lookup', { query: 'a' }))

        return 'done'
      })

      const modules = codeModeModules(executor, [queryTool('lookup')], {
        afterNestedCall: () => {
          throw new Error('metrics exporter threw')
        }
      })

      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])
      const toolSet = yield* resolveTools(modules, context)

      const result = yield* toolSet
        .execute(ToolCall.make({ id: 'call_1', name: 'codemode', params: { code: 'script' } }))
        .pipe(Effect.provide(logger))

      expect(result.isError).toBeUndefined()
      expect(settled).toEqual(['lookup:a'])
      expect(result.nestedCalls?.calls.map(record => record.status)).toEqual(['ok'])
      expect(result.nestedCalls?.counts).toEqual({ ok: 1, error: 0, cancelled: 0 })
      expect(messages).toContainEqual([
        expect.stringContaining('afterNestedCall failed for call_1/1')
      ])
    })
  )

  it.effect('reports nested outcomes to afterNestedCall, including interrupted calls', () =>
    Effect.gen(function* () {
      const seen: Array<CodeModeAfterNestedCallInput<TestContext>> = []

      const slow = makeTool<TestContext, typeof NoteParams>({
        name: 'slow',
        description: 'Never finishes',
        parameters: NoteParams,
        access: 'read',
        execute: () => Effect.never
      })

      const { executor } = scriptedExecutor(async call => {
        await call('lookup', { query: 'a' })
        await call('failing', { query: 'b' }).catch(() => undefined)
        await call('blocked', { query: 'c' }).catch(() => undefined)
        // Left running when the script returns: cancelled by the host.
        call('slow', { note: 'd' }).catch(() => undefined)

        return 'done'
      })

      const modules = codeModeModules(
        executor,
        [queryTool('lookup'), queryTool('failing', { fail: true }), queryTool('blocked'), slow],
        {
          beforeNestedCall: ({ call }) =>
            call.name === 'blocked' ? Effect.fail('blocked by policy') : Effect.void,
          afterNestedCall: input =>
            Effect.sync(() => {
              seen.push(input)
            })
        }
      )

      const toolSet = yield* resolveTools(modules, context)

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'codemode', params: { code: 'script' } })
      )

      expect(seen.map(input => [input.call.id, input.call.name, input.outcome])).toEqual([
        ['call_1/1', 'lookup', 'success'],
        ['call_1/2', 'failing', 'failure'],
        ['call_1/4', 'slow', 'interrupted']
      ])
      expect(seen.every(input => input.context === context && input.durationMs >= 0)).toBe(true)
      expect(seen[0]?.result?.content).toBe('lookup:a')
      expect(seen[2]?.result).toBeUndefined()
      expect(result.nestedCalls?.counts).toEqual({ ok: 1, error: 2, cancelled: 1 })
    })
  )
})
