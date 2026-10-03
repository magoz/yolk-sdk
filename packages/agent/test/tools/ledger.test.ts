import { createHash } from 'node:crypto'
import {
  Cause,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  Option,
  Predicate,
  Result
} from 'effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  ImagePart,
  inlineBase64AttachmentSource,
  NestedToolCallRecord,
  NestedToolCalls,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  makeInMemoryToolLedgerStore,
  makeTool,
  resolveTools,
  toolIdempotencyKey,
  toolLedgerCompleteTimeoutMs,
  ToolLedgerEntry,
  ToolLedgerError,
  toolLedgerArgs,
  toolLedgerResult,
  ToolLedgerFailed,
  ToolLedgerSucceeded,
  type ToolLedgerClaimRequest,
  type ToolLedgerDecisionEvent,
  type ToolLedgerHeartbeatRequest,
  type ToolLedgerOptions,
  type ToolLedgerStore,
  type ToolModule,
  type ToolRegistration
} from '../../src/tools'

type TestContext = { readonly tenant: string }

const context: TestContext = { tenant: 'tenant_1' }

const NoteParams = Schema.Struct({ note: Schema.String })

type Probe = {
  readonly runs: Array<string>
  readonly keys: Array<string | undefined>
}

const makeProbe = (): Probe => ({ runs: [], keys: [] })

const noteTool = (
  probe: Probe,
  options: {
    readonly name?: string
    readonly access?: 'read' | 'write' | 'destructive'
    readonly sleep?: Duration.Input
    readonly fail?: boolean
  } = {}
): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof NoteParams>({
    name: options.name ?? 'append_note',
    description: 'Append a note',
    parameters: NoteParams,
    access: options.access ?? 'write',
    execute: ({ call, params, idempotencyKey }) =>
      Effect.gen(function* () {
        probe.runs.push(params.note)
        probe.keys.push(idempotencyKey)

        if (options.sleep !== undefined) yield* Effect.sleep(options.sleep)

        if (options.fail === true) {
          return yield* Effect.fail(
            new ToolError({ tool: call.name, cause: 'execution', message: 'upstream rejected' })
          )
        }

        return ToolResult.make({
          toolCallId: call.id,
          content: `appended ${params.note} (${probe.runs.length})`,
          structuredContent: { run: probe.runs.length }
        })
      })
  })

const modules = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ReadonlyArray<ToolModule<TestContext>> => [{ id: 'crm', tools }]

const noteCall = (id = 'call_1', note = 'hot lead') =>
  ToolCall.make({ id, name: 'append_note', params: { note } })

// One resolution per "step execution", as a host re-executing a step would do.
const execute = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>,
  call: ToolCall,
  ledger?: ToolLedgerOptions
) =>
  Effect.gen(function* () {
    const toolSet = yield* resolveTools(
      modules(tools),
      context,
      ledger === undefined ? {} : { ledger }
    )

    return yield* toolSet.execute(call)
  })

const resultText = (result: ToolResult) =>
  Predicate.isString(result.content) ? result.content : JSON.stringify(result.content)

describe('tool ledger', () => {
  it.effect('returns the stored result for a write re-executed after completion', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore({ scope: 'run_1' })
      const tools = [noteTool(probe)]

      const first = yield* execute(tools, noteCall(), { store })
      const second = yield* execute(tools, noteCall(), { store })

      expect(probe.runs).toEqual(['hot lead'])
      expect(second).toEqual(first)
      expect(second.content).toBe('appended hot lead (1)')
      expect(second.structuredContent).toEqual({ run: 1 })

      const [entry] = yield* store.entries

      expect(entry?.key).toBe('call_1')
      expect(entry?.toolName).toBe('append_note')
      expect(entry?.args).toBe('{"note":"hot lead"}')
      expect(entry?.outcome?._tag).toBe('Succeeded')
    })
  )

  it.effect('makes a concurrent duplicate wait and executes the call once', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore({ scope: 'run_1' })
      const tools = [noteTool(probe, { sleep: '12 seconds' })]
      const ledger: ToolLedgerOptions = { store, leaseMs: 5_000, pollIntervalMs: 500 }

      const first = yield* Effect.forkChild(execute(tools, noteCall(), ledger))

      yield* TestClock.adjust('1 second')

      const second = yield* Effect.forkChild(execute(tools, noteCall(), ledger))

      // Longer than the lease: heartbeats keep the first execution in flight.
      yield* TestClock.adjust('15 seconds')

      const [firstResult, secondResult] = [yield* Fiber.join(first), yield* Fiber.join(second)]

      expect(probe.runs).toEqual(['hot lead'])
      expect(secondResult).toEqual(firstResult)
    })
  )

  it.effect('never executes a duplicate past its wait deadline', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { sleep: '1 minute' })]

      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store }))

      yield* TestClock.adjust('1 second')

      const second = yield* Effect.forkChild(
        execute(tools, noteCall(), { store, maxWaitMs: 5_000 })
      )

      yield* TestClock.adjust('6 seconds')

      const timedOut = yield* Fiber.join(second)

      expect(timedOut.isError).toBe(true)
      expect(resultText(timedOut)).toContain('is still running in another execution')
      expect(timedOut.structuredContent).toMatchObject({
        type: 'model_visible_tool_error',
        reason: 'timeout',
        details: { type: 'tool_ledger', state: 'in_flight', key: 'call_1' }
      })
      expect(probe.runs).toEqual(['hot lead'])

      yield* Fiber.interrupt(first)
    })
  )

  it.effect('replays a call that completes in the last poll interval of the wait', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const decisions: Array<ToolLedgerDecisionEvent> = []

      // Completes at 5.2 s, after the regular poll at 5 s and before the wait ends at 6 s.
      const tools = [noteTool(probe, { sleep: '5200 millis' })]
      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store }))

      yield* TestClock.adjust('1 second')

      const second = yield* Effect.forkChild(
        execute(tools, noteCall(), {
          store,
          maxWaitMs: 5_000,
          pollIntervalMs: 1_000,
          onLedgerDecision: event => {
            decisions.push(event)
          }
        })
      )

      yield* TestClock.adjust('5 seconds')

      const [firstResult, secondResult] = [yield* Fiber.join(first), yield* Fiber.join(second)]

      expect(secondResult).toEqual(firstResult)
      expect(decisions).toEqual([
        { key: 'call_1', toolName: 'append_note', decision: 'in_flight_wait', waitedMs: 4_500 }
      ])
      expect(probe.runs).toEqual(['hot lead'])
    })
  )

  it.effect('polls once within a wait shorter than the poll interval', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const decisions: Array<ToolLedgerDecisionEvent> = []

      // Completes 800 ms after the duplicate starts waiting 2 s with a 5 s poll interval.
      const tools = [noteTool(probe, { sleep: '1800 millis' })]
      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store }))

      yield* TestClock.adjust('1 second')

      const second = yield* Effect.forkChild(
        execute(tools, noteCall(), {
          store,
          maxWaitMs: 2_000,
          pollIntervalMs: 5_000,
          onLedgerDecision: event => {
            decisions.push(event)
          }
        })
      )

      yield* TestClock.adjust('2 seconds')

      const [firstResult, secondResult] = [yield* Fiber.join(first), yield* Fiber.join(second)]

      expect(secondResult).toEqual(firstResult)
      expect(decisions).toEqual([
        { key: 'call_1', toolName: 'append_note', decision: 'in_flight_wait', waitedMs: 1_000 }
      ])
      expect(probe.runs).toEqual(['hot lead'])
    })
  )

  it.effect('bounds a stalled polling claim by the remaining wait budget', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { sleep: '1 minute' })]
      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store: memory }))

      yield* TestClock.adjust('1 second')

      let claims = 0

      // The duplicate's first claim sees the call in flight; every later poll stalls.
      const stalling: ToolLedgerStore = {
        ...memory,
        claim: request => (claims++ === 0 ? memory.claim(request) : Effect.never)
      }

      const second = yield* Effect.forkChild(
        execute(tools, noteCall(), { store: stalling, maxWaitMs: 5_000, pollIntervalMs: 1_000 })
      )

      const joined = yield* Effect.forkChild(
        Fiber.join(second).pipe(Effect.timeoutOption('10 seconds'))
      )

      yield* TestClock.adjust('11 seconds')

      const result = yield* Fiber.join(joined)

      expect(Option.isSome(result)).toBe(true)
      expect(Option.getOrUndefined(result)?.structuredContent).toMatchObject({
        reason: 'timeout',
        details: { type: 'tool_ledger', state: 'in_flight', key: 'call_1' }
      })
      expect(claims).toBe(2)
      expect(probe.runs).toEqual(['hot lead'])

      yield* Fiber.interrupt(first)
    })
  )

  it.effect('ends a wait at the deadline option before maxWaitMs', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { sleep: '1 minute' })]
      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store }))

      yield* TestClock.adjust('1 second')

      const second = yield* Effect.forkChild(
        execute(tools, noteCall(), { store, maxWaitMs: 60_000, deadline: () => 4_000 })
      )

      yield* TestClock.adjust('3 seconds')

      const timedOut = yield* Fiber.join(second)

      expect(timedOut.structuredContent).toMatchObject({
        reason: 'timeout',
        details: { state: 'in_flight' }
      })
      expect(probe.runs).toEqual(['hot lead'])

      yield* Fiber.interrupt(first)
    })
  )

  it.effect('ignores a non-finite deadline', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { sleep: '1 minute' })]
      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store }))

      yield* TestClock.adjust('1 second')

      const second = yield* Effect.forkChild(
        execute(tools, noteCall(), { store, maxWaitMs: 3_000, deadline: () => Number.NaN }).pipe(
          Effect.timeoutOption('10 seconds')
        )
      )

      yield* TestClock.adjust('10 seconds')

      const timedOut = yield* Fiber.join(second)

      expect(Option.getOrUndefined(timedOut)?.structuredContent).toMatchObject({
        reason: 'timeout',
        details: { state: 'in_flight' }
      })

      yield* Fiber.interrupt(first)
    })
  )

  it.effect('fails closed when a polling claim fails', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { sleep: '1 minute' })]
      const first = yield* Effect.forkChild(execute(tools, noteCall(), { store: memory }))

      yield* TestClock.adjust('1 second')

      let claims = 0

      const failing: ToolLedgerStore = {
        ...memory,
        claim: request =>
          claims++ === 0
            ? memory.claim(request)
            : Effect.fail(new ToolLedgerError({ message: 'database down' }))
      }

      const second = yield* Effect.forkChild(
        Effect.exit(execute(tools, noteCall(), { store: failing, pollIntervalMs: 500 }))
      )

      yield* TestClock.adjust('1 second')

      const exit = yield* Fiber.join(second)

      expect(exit).toEqual(
        Exit.fail(
          new ToolError({
            tool: 'append_note',
            cause: 'unavailable',
            message: 'The tool ledger is unavailable (database down); append_note was not run.'
          })
        )
      )
      expect(probe.runs).toEqual(['hot lead'])

      yield* Fiber.interrupt(first)
    })
  )

  it.effect('reports a conflict with an in-flight call without waiting for it', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const decisions: Array<ToolLedgerDecisionEvent> = []
      const tools = [noteTool(probe, { sleep: '1 minute' })]

      const first = yield* Effect.forkChild(execute(tools, noteCall('call_1', 'first'), { store }))

      yield* TestClock.adjust('1 second')

      // No clock adjustment: a wait would never finish.
      const conflict = yield* execute(tools, noteCall('call_1', 'second'), {
        store,
        onLedgerDecision: event => {
          decisions.push(event)
        }
      })

      expect(conflict.structuredContent).toMatchObject({ details: { state: 'conflict' } })
      expect(decisions).toEqual([{ key: 'call_1', toolName: 'append_note', decision: 'conflict' }])
      expect(probe.runs).toEqual(['first'])

      yield* Fiber.interrupt(first)
    })
  )

  it.effect('logs heartbeat failures and still records the outcome', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()

      const store: ToolLedgerStore = {
        ...memory,
        heartbeat: () => Effect.fail(new ToolLedgerError({ message: 'lease update failed' }))
      }

      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])

      const running = yield* Effect.forkChild(
        execute([noteTool(probe, { sleep: '5 seconds' })], noteCall(), {
          store,
          leaseMs: 4_000
        }).pipe(Effect.provide(logger))
      )

      yield* TestClock.adjust('5 seconds')

      const result = yield* Fiber.join(running)
      const [entry] = yield* memory.entries

      expect(result.content).toBe('appended hot lead (1)')
      expect(entry?.outcome?._tag).toBe('Succeeded')
      expect(messages.length).toBeGreaterThan(0)
      expect(messages).toContainEqual([
        'Tool ledger heartbeat failed for call_1: lease update failed'
      ])
    })
  )

  it.effect('times out and logs a hung heartbeat', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()
      const store: ToolLedgerStore = { ...memory, heartbeat: () => Effect.never }
      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])

      const running = yield* Effect.forkChild(
        execute([noteTool(probe, { sleep: '10 seconds' })], noteCall(), {
          store,
          leaseMs: 6_000
        }).pipe(Effect.provide(logger))
      )

      yield* TestClock.adjust('10 seconds')

      const result = yield* Fiber.join(running)
      const [entry] = yield* memory.entries

      expect(result.content).toBe('appended hot lead (1)')
      expect(entry?.outcome?._tag).toBe('Succeeded')
      // First heartbeat at 2 s, timed out at 7 s; the next one starts 2 s later.
      expect(messages).toEqual([
        [
          `Tool ledger heartbeat failed for call_1: timed out after ${toolLedgerCompleteTimeoutMs} ms`
        ]
      ])
    })
  )

  it.effect('never re-executes an abandoned call', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { sleep: '1 minute' })]
      const ledger: ToolLedgerOptions = { store, leaseMs: 10_000 }

      // The first execution dies mid-call: interruption leaves the entry claimed, like a crash.
      const crashed = yield* Effect.forkChild(execute(tools, noteCall(), ledger))

      yield* TestClock.adjust('1 second')
      yield* Fiber.interrupt(crashed)
      yield* TestClock.adjust('20 seconds')

      const result = yield* execute(tools, noteCall(), ledger)

      expect(probe.runs).toEqual(['hot lead'])
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('may already have been applied')
      expect(result.structuredContent).toMatchObject({
        reason: 'unavailable',
        details: { type: 'tool_ledger', state: 'abandoned', key: 'call_1' }
      })
    })
  )

  it.effect('replays a recorded ToolError as the same failure', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { fail: true })]

      const first = yield* Effect.exit(execute(tools, noteCall(), { store }))
      const second = yield* Effect.exit(execute(tools, noteCall(), { store }))

      expect(probe.runs).toHaveLength(1)
      expect(Exit.isFailure(first) && Exit.isFailure(second)).toBe(true)
      expect(second).toEqual(first)
    })
  )

  it.effect('lets read tools bypass the ledger', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore({ scope: 'run_1' })
      const tools = [noteTool(probe, { access: 'read' })]

      yield* execute(tools, noteCall(), { store })
      yield* execute(tools, noteCall(), { store })

      expect(probe.runs).toEqual(['hot lead', 'hot lead'])
      expect(yield* store.entries).toEqual([])
      // Ledger configured: every call still gets its stable idempotency key.
      expect(probe.keys).toEqual(['run_1:call_1', 'run_1:call_1'])
    })
  )

  it.effect('honors a host ledger policy', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe, { access: 'read' })]

      const ledger: ToolLedgerOptions = {
        store,
        isLedgered: ({ call }) => call.name === 'append_note'
      }

      yield* execute(tools, noteCall(), ledger)
      yield* execute(tools, noteCall(), ledger)

      expect(probe.runs).toEqual(['hot lead'])
    })
  )

  it.effect('keeps behavior unchanged without a ledger', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const tools = [noteTool(probe)]

      const first = yield* execute(tools, noteCall())
      const second = yield* execute(tools, noteCall())

      expect(probe.runs).toEqual(['hot lead', 'hot lead'])
      expect(probe.keys).toEqual([undefined, undefined])
      expect(first.content).toBe('appended hot lead (1)')
      expect(second.content).toBe('appended hot lead (2)')
    })
  )

  it.effect('derives a stable idempotency key from the scope and ledger key', () =>
    Effect.gen(function* () {
      const probe = makeProbe()

      const ledger = (): ToolLedgerOptions => ({
        store: makeInMemoryToolLedgerStore({ scope: 'wrun_42' }),
        isLedgered: () => false
      })

      const tools = [noteTool(probe)]

      // Separate stores and resolutions: the key depends only on scope and call id.
      yield* execute(tools, noteCall(), ledger())
      yield* execute(tools, noteCall(), ledger())

      expect(probe.keys).toEqual(['wrun_42:call_1', 'wrun_42:call_1'])
      expect(toolIdempotencyKey('wrun_42', 'call_1')).toBe('wrun_42:call_1')
    })
  )

  it.effect('reports a different call under the same key as a conflict without running it', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe)]

      yield* execute(tools, noteCall('call_1', 'first'), { store })

      const conflict = yield* execute(tools, noteCall('call_1', 'second'), { store })

      expect(probe.runs).toEqual(['first'])
      expect(conflict.isError).toBe(true)
      expect(conflict.structuredContent).toMatchObject({ details: { state: 'conflict' } })
    })
  )

  it.effect('detects a conflict past the bounded argument preview', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe)]
      const prefix = 'p'.repeat(9 * 1024)

      const first = yield* execute(tools, noteCall('call_1', `${prefix}-first`), { store })
      const conflict = yield* execute(tools, noteCall('call_1', `${prefix}-second`), { store })
      const [entry] = yield* store.entries

      expect(probe.runs).toEqual([`${prefix}-first`])
      expect(first.isError).toBeUndefined()
      expect(conflict.isError).toBe(true)
      expect(conflict.structuredContent).toMatchObject({ details: { state: 'conflict' } })
      // The preview stays bounded; the digest covers the full arguments.
      expect(entry?.args.endsWith('…')).toBe(true)
      expect(entry?.argsTruncated).toBe(true)
      expect(entry?.argsDigest).toMatch(/^[0-9a-f]{64}$/)
    })
  )

  it.effect('matches arguments by canonical JSON, independent of key order', () =>
    Effect.gen(function* () {
      const store = makeInMemoryToolLedgerStore()
      const left = toolLedgerArgs({ b: [1, { y: 2, x: 1 }], a: 'é' })
      const right = toolLedgerArgs({ a: 'é', b: [1, { x: 1, y: 2 }] })

      expect(left.argsDigest).toBe(right.argsDigest)
      expect(left.args).toBe('{"b":[1,{"y":2,"x":1}],"a":"é"}')
      expect(left.argsTruncated).toBe(false)
      expect(toolLedgerArgs('x'.repeat(9_000)).argsTruncated).toBe(true)
      expect(toolLedgerArgs({ a: 'é' }).argsDigest).not.toBe(left.argsDigest)
      expect(yield* store.entries).toEqual([])
    })
  )

  it.effect('digests arguments with SHA-256 over their canonical JSON', () =>
    Effect.gen(function* () {
      const webCryptoHex = (text: string) =>
        Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).pipe(
          Effect.map(buffer =>
            Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
          )
        )

      // Block boundaries (55/56/64 bytes), multi-byte text, and multi-block inputs.
      const values = [
        'x'.repeat(53),
        'x'.repeat(54),
        'x'.repeat(62),
        'é😀\u0001'.repeat(300),
        'y'.repeat(100_000)
      ]

      for (const value of values) {
        expect(toolLedgerArgs(value).argsDigest).toBe(yield* webCryptoHex(JSON.stringify(value)))
      }

      expect(toolLedgerArgs({ b: 1, a: [true, null] }).argsDigest).toBe(
        yield* webCryptoHex('{"a":[true,null],"b":1}')
      )
    })
  )

  it('pins the argsDigest format: SHA-256 hex of sorted-key canonical JSON', () => {
    const args = toolLedgerArgs({
      zeta: [1, 2.5, -0, 1e21, '\u00fc'],
      '\u00e9': { b: true, a: null },
      A: 'x',
      '\u00df': [{ y: 1, x: [] }]
    })

    // Keys sorted by UTF-16 code units (A < zeta < ß < é); JSON.stringify number rules.
    const canonical =
      '{"A":"x","zeta":[1,2.5,0,1e+21,"\u00fc"],"\u00df":[{"x":[],"y":1}],"\u00e9":{"a":null,"b":true}}'

    expect(args.argsDigest).toBe('2057e870a5ba91cd8ff8867ab281a396ed31171656adcb25f07599f904b613a4')
    expect(args.argsDigest).toBe(createHash('sha256').update(canonical).digest('hex'))
  })

  it('digests arguments nested too deeply to canonicalize from their compact JSON', () => {
    type Nested = number | { readonly a: Nested }

    const nest = (depth: number): Nested => {
      let nested: Nested = 1

      for (let level = 0; level < depth; level++) nested = { a: nested }

      return nested
    }

    // Mirrors the per-level stack cost of the ledger's canonical recursion.
    const canonicalLike = (value: Nested): string =>
      Predicate.isNumber(value)
        ? JSON.stringify(value)
        : `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalLike(value.a)}`)
            .join(',')}}`

    const deepestPassing = (passes: (depth: number) => boolean) => {
      let low = 1
      let high = 100_000

      while (low < high) {
        const middle = Math.ceil((low + high) / 2)

        if (passes(middle)) low = middle
        else high = middle - 1
      }

      return low
    }

    // Stack limits differ between runtimes (Node 22 overflows JSON.stringify at a depth Node 24
    // handles), so measure them here. Use three quarters of the JSON round-trip limit: headroom for
    // the ledger's deeper call site, yet past the canonical recursion's limit, so the ledger falls
    // back to digesting the compact JSON.
    const roundTripLimit = deepestPassing(depth =>
      Result.isSuccess(Result.try(() => JSON.parse(JSON.stringify(nest(depth)))))
    )

    const canonicalLimit = deepestPassing(depth =>
      Result.isSuccess(Result.try(() => canonicalLike(nest(depth))))
    )

    const depth = Math.floor(roundTripLimit * 0.75)

    expect(depth).toBeGreaterThan(canonicalLimit)

    const deep = nest(depth)
    const compact = JSON.stringify(deep)
    const digested = toolLedgerArgs(deep)

    expect(digested.argsDigest).toBe(createHash('sha256').update(compact).digest('hex'))
    expect(toolLedgerArgs(JSON.parse(compact)).argsDigest).toBe(digested.argsDigest)
    expect(digested.argsTruncated).toBe(true)
  })

  it.effect('bounds each completion attempt when the store hangs', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()
      let attempts = 0

      const store: ToolLedgerStore = {
        ...memory,
        complete: () =>
          Effect.suspend(() => {
            attempts++

            return Effect.never
          })
      }

      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])

      const running = yield* Effect.forkChild(
        execute([noteTool(probe)], noteCall(), { store }).pipe(
          Effect.provide(logger),
          Effect.timeoutOption('1 minute')
        )
      )

      yield* TestClock.adjust(`${3 * toolLedgerCompleteTimeoutMs} millis`)

      const result = yield* Fiber.join(running)
      const [entry] = yield* memory.entries

      expect(Option.getOrUndefined(result)?.content).toBe('appended hot lead (1)')
      expect(attempts).toBe(3)
      expect(entry?.outcome).toBeUndefined()
      expect(messages).toEqual([
        [
          `Tool ledger completion failed for call_1; the call stays claimed and will read as abandoned: timed out after ${toolLedgerCompleteTimeoutMs} ms`
        ]
      ])
    })
  )

  it.effect('records a ToolError even when its cause also carries interruptions', () =>
    Effect.gen(function* () {
      const store = makeInMemoryToolLedgerStore()
      const error = new ToolError({ tool: 'append_note', cause: 'execution', message: 'rejected' })

      // A typed failure whose cause also holds an interruption, as from interrupted sibling or
      // cleanup work inside the tool (for example a forked worker joined after it was cancelled).
      const failing: ToolRegistration<TestContext> = makeTool<TestContext, typeof NoteParams>({
        name: 'append_note',
        description: 'Append a note',
        parameters: NoteParams,
        access: 'write',
        execute: () => Effect.failCause(Cause.combine(Cause.fail(error), Cause.interrupt()))
      })

      const first = yield* Effect.exit(execute([failing], noteCall(), { store }))
      const [entry] = yield* store.entries

      expect(Exit.isFailure(first) && Cause.findErrorOption(first.cause)).toEqual(
        Option.some(error)
      )
      expect(entry?.outcome).toEqual(
        ToolLedgerFailed.make({
          error: { tool: 'append_note', cause: 'execution', message: 'rejected' }
        })
      )
      expect(yield* Effect.exit(execute([failing], noteCall(), { store }))).toEqual(
        Exit.fail(error)
      )
    })
  )

  it.effect('never records an outcome for a defect', () =>
    Effect.gen(function* () {
      const store = makeInMemoryToolLedgerStore()

      const dying: ToolRegistration<TestContext> = {
        def: ToolDef.make({
          name: 'append_note',
          description: 'Append a note',
          parameters: { type: 'object', properties: { note: { type: 'string' } } }
        }),
        access: 'write',
        execute: () => Effect.die('connection reset mid-write')
      }

      const exit = yield* Effect.exit(execute([dying], noteCall(), { store }))
      const [entry] = yield* store.entries

      expect(Exit.isFailure(exit)).toBe(true)
      expect(entry?.outcome).toBeUndefined()
    })
  )

  it.effect('fails closed when the ledger cannot claim', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()

      const store: ToolLedgerStore = {
        ...memory,
        claim: () => Effect.fail(new ToolLedgerError({ message: 'database down' }))
      }

      const exit = yield* Effect.exit(execute([noteTool(probe)], noteCall(), { store }))

      expect(probe.runs).toEqual([])
      expect(exit).toEqual(
        Exit.fail(
          new ToolError({
            tool: 'append_note',
            cause: 'unavailable',
            message: 'The tool ledger is unavailable (database down); append_note was not run.'
          })
        )
      )
    })
  )

  it.effect('returns the live result when completion fails, leaving the call claimed', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()

      const store: ToolLedgerStore = {
        ...memory,
        complete: () => Effect.fail(new ToolLedgerError({ message: 'write failed' }))
      }

      const result = yield* execute([noteTool(probe)], noteCall(), { store })
      const [entry] = yield* memory.entries

      expect(result.content).toBe('appended hot lead (1)')
      expect(entry?.outcome).toBeUndefined()
    })
  )

  it.effect('returns the live result when building its stored copy throws', () =>
    Effect.gen(function* () {
      const store = makeInMemoryToolLedgerStore()

      // An unchecked result the stored copy cannot rebuild (`toolCallId` must be trimmed).
      const unchecked: ToolRegistration<TestContext> = makeTool<TestContext, typeof NoteParams>({
        name: 'append_note',
        description: 'Append a note',
        parameters: NoteParams,
        access: 'write',
        execute: ({ call }) =>
          Effect.succeed(
            ToolResult.make(
              { toolCallId: `${call.id} `, content: 'applied' },
              { disableChecks: true }
            )
          )
      })

      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])

      const result = yield* execute([unchecked], noteCall(), { store }).pipe(Effect.provide(logger))

      const [entry] = yield* store.entries

      expect(result.content).toBe('applied')
      expect(entry?.outcome).toBeUndefined()
      expect(messages).toEqual([
        [
          expect.stringContaining(
            'Tool ledger could not record the outcome of call_1; the call stays claimed and will read as abandoned:'
          )
        ]
      ])
    })
  )

  it.effect('ledgers nested calls under <parentCallId>/<seq> with the parent key', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore({ scope: 'run_1' })

      const runner: ToolRegistration<TestContext> = {
        ...makeTool<TestContext, typeof NoteParams>({
          name: 'runner',
          description: 'Runs nested calls',
          parameters: NoteParams,
          access: 'write',
          nestedToolAccess: true,
          execute: ({ call, nested }) =>
            Effect.gen(function* () {
              if (nested === undefined) return yield* Effect.die('nested access missing')

              const results = yield* Effect.forEach([1, 2], seq =>
                nested.execute(
                  ToolCall.make({
                    id: `${call.id}/${seq}`,
                    name: seq === 1 ? 'append_note' : 'lookup',
                    params: { note: `n${seq}` }
                  })
                )
              )

              return ToolResult.make({
                toolCallId: call.id,
                content: results.map(resultText).join(', ')
              })
            })
        })
      }

      const tools = [runner, noteTool(probe), noteTool(probe, { name: 'lookup', access: 'read' })]
      const runCall = ToolCall.make({ id: 'call_9', name: 'runner', params: { note: 'go' } })

      const decisions: Array<ToolLedgerDecisionEvent> = []

      const ledger: ToolLedgerOptions = {
        store,
        onLedgerDecision: event => {
          decisions.push(event)
        }
      }

      yield* execute(tools, runCall, ledger)

      const replayed = yield* execute(tools, runCall, ledger)
      const entries = yield* store.entries

      expect(probe.runs).toEqual(['n1', 'n2'])
      expect(probe.keys).toEqual(['run_1:call_9/1', 'run_1:call_9/2'])
      expect(entries.map(entry => [entry.key, entry.parentKey])).toEqual([
        ['call_9', undefined],
        ['call_9/1', 'call_9']
      ])
      expect(replayed.content).toBe('appended n1 (1), appended n2 (2)')
      expect(yield* store.list('call_9')).toHaveLength(1)
      // Reads are not ledgered, so they report no decision.
      expect(decisions).toEqual([
        { key: 'call_9', toolName: 'runner', decision: 'fresh' },
        { key: 'call_9/1', parentKey: 'call_9', toolName: 'append_note', decision: 'fresh' },
        { key: 'call_9', toolName: 'runner', decision: 'completed' }
      ])
    })
  )

  it.effect('passes the lease length to claim and heartbeat for stores on their own clock', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()
      const claims: Array<ToolLedgerClaimRequest> = []
      const heartbeats: Array<ToolLedgerHeartbeatRequest> = []

      const store: ToolLedgerStore = {
        ...memory,
        claim: request => {
          claims.push(request)

          return memory.claim(request)
        },
        heartbeat: request => {
          heartbeats.push(request)

          return memory.heartbeat(request)
        }
      }

      const ledger: ToolLedgerOptions = { store, leaseMs: 9_000, heartbeatIntervalMs: 3_000 }

      const running = yield* Effect.forkChild(
        execute([noteTool(probe, { sleep: '7 seconds' })], noteCall(), ledger)
      )

      yield* TestClock.adjust('8 seconds')
      yield* Fiber.join(running)

      expect(claims).toEqual([
        expect.objectContaining({ nowMs: 0, leaseExpiresAtMs: 9_000, leaseMs: 9_000 })
      ])
      expect(heartbeats).toEqual([
        { key: 'call_1', leaseExpiresAtMs: 12_000, leaseMs: 9_000 },
        { key: 'call_1', leaseExpiresAtMs: 15_000, leaseMs: 9_000 }
      ])
    })
  )

  it.effect('heartbeats at most every half lease', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const memory = makeInMemoryToolLedgerStore()
      const heartbeats: Array<number> = []

      const store: ToolLedgerStore = {
        ...memory,
        heartbeat: request => {
          heartbeats.push(request.leaseExpiresAtMs)

          return memory.heartbeat(request)
        }
      }

      const running = yield* Effect.forkChild(
        execute([noteTool(probe, { sleep: '5 seconds' })], noteCall(), {
          store,
          leaseMs: 4_000,
          heartbeatIntervalMs: 60_000
        })
      )

      yield* TestClock.adjust('5 seconds')
      yield* Fiber.join(running)

      expect(heartbeats).toEqual([6_000, 8_000])
    })
  )

  it.effect('reports one decision per ledgered call to onLedgerDecision', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const decisions: Array<ToolLedgerDecisionEvent> = []
      const store = makeInMemoryToolLedgerStore()

      const ledger = (options: Partial<ToolLedgerOptions> = {}): ToolLedgerOptions => ({
        store,
        leaseMs: 10_000,
        pollIntervalMs: 500,
        onLedgerDecision: event => {
          decisions.push(event)
        },
        ...options
      })

      const fast = [noteTool(probe)]
      const slow = [noteTool(probe, { sleep: '3 seconds' })]
      const blocked = [noteTool(probe, { sleep: '1 hour' })]

      // fresh, then completed
      yield* execute(fast, noteCall('call_a'), ledger())
      yield* execute(fast, noteCall('call_a'), ledger())

      // in_flight_wait: a concurrent duplicate waits for the running call
      const running = yield* Effect.forkChild(execute(slow, noteCall('call_b'), ledger()))

      yield* TestClock.adjust('1 second')

      const waiting = yield* Effect.forkChild(execute(slow, noteCall('call_b'), ledger()))

      yield* TestClock.adjust('3 seconds')
      yield* Fiber.join(running)
      yield* Fiber.join(waiting)

      // in_flight_timeout
      const stuck = yield* Effect.forkChild(execute(blocked, noteCall('call_c'), ledger()))

      yield* TestClock.adjust('1 second')

      const timingOut = yield* Effect.forkChild(
        execute(blocked, noteCall('call_c'), ledger({ maxWaitMs: 2_000 }))
      )

      yield* TestClock.adjust('2 seconds')
      yield* Fiber.join(timingOut)

      // abandoned: the stuck execution dies and its lease runs out
      yield* Fiber.interrupt(stuck)
      yield* TestClock.adjust('20 seconds')
      yield* execute(blocked, noteCall('call_c'), ledger())

      // conflict
      yield* execute(fast, noteCall('call_a', 'different'), ledger())

      expect(decisions).toEqual([
        { key: 'call_a', toolName: 'append_note', decision: 'fresh' },
        { key: 'call_a', toolName: 'append_note', decision: 'completed' },
        { key: 'call_b', toolName: 'append_note', decision: 'fresh' },
        { key: 'call_b', toolName: 'append_note', decision: 'in_flight_wait', waitedMs: 2_000 },
        { key: 'call_c', toolName: 'append_note', decision: 'fresh' },
        // The final poll runs halfway through the last 500 ms of the 2 s wait; it is the last one.
        {
          key: 'call_c',
          toolName: 'append_note',
          decision: 'in_flight_timeout',
          waitedMs: 1_750
        },
        { key: 'call_c', toolName: 'append_note', decision: 'abandoned' },
        { key: 'call_a', toolName: 'append_note', decision: 'conflict' }
      ])
      expect(probe.runs).toEqual(['hot lead', 'hot lead', 'hot lead'])
    })
  )

  it.effect('never lets a failing onLedgerDecision affect execution', () =>
    Effect.gen(function* () {
      const probe = makeProbe()
      const store = makeInMemoryToolLedgerStore()
      const tools = [noteTool(probe)]

      const throwing: ToolLedgerOptions = {
        store,
        onLedgerDecision: () => {
          throw new Error('metrics down')
        }
      }

      const rejecting: ToolLedgerOptions = {
        store,
        onLedgerDecision: () => Promise.reject(new Error('metrics down'))
      }

      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make(options => messages.push(options.message))])

      const first = yield* execute(tools, noteCall(), throwing).pipe(Effect.provide(logger))
      const second = yield* execute(tools, noteCall(), rejecting).pipe(Effect.provide(logger))

      // The rejected promise is observed by a detached fiber; let it settle.
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 10)))

      expect(probe.runs).toEqual(['hot lead'])
      expect(first.content).toBe('appended hot lead (1)')
      expect(second).toEqual(first)
      expect(messages).toEqual([
        ['Tool ledger onLedgerDecision failed for call_1; ignored: metrics down'],
        ['Tool ledger onLedgerDecision failed for call_1; ignored: metrics down']
      ])
    })
  )

  it('bounds stored results by their serialized UTF-8 size, escapes included', () => {
    const bytes = (result: ToolResult) => new TextEncoder().encode(JSON.stringify(result)).length

    // \u0001 serializes as a six-byte escape; quotes and backslashes as two.
    for (const text of ['\u0001'.repeat(5_000), '"\\'.repeat(5_000), 'é😀'.repeat(3_000)]) {
      for (const maxBytes of [2_000, 400, 120]) {
        const stored = toolLedgerResult(
          ToolResult.make({ toolCallId: 'call_1', content: text }),
          maxBytes
        )

        expect(bytes(stored)).toBeLessThanOrEqual(maxBytes)
        expect(resultText(stored)).toContain(maxBytes >= 400 ? 'reduced to fit' : '')
      }
    }

    // Below the size of the identifying fields, only an empty content is left.
    const tiny = toolLedgerResult(
      ToolResult.make({ toolCallId: 'call_1', content: 'x'.repeat(100), isError: true }),
      10
    )

    expect(tiny).toEqual(ToolResult.make({ toolCallId: 'call_1', content: '', isError: true }))
  })

  it('cuts a multi-megabyte text result to the bound without losing its prefix', () => {
    const bytes = (result: ToolResult) => new TextEncoder().encode(JSON.stringify(result)).length
    const text = 'é😀x\u0001'.repeat(1_000_000)
    const stored = toolLedgerResult(ToolResult.make({ toolCallId: 'call_1', content: text }))
    const content = resultText(stored)
    const kept = content.slice(0, content.indexOf('…'))

    expect(bytes(stored)).toBeLessThanOrEqual(1024 * 1024)
    // The longest fitting prefix: one more code point would not fit.
    expect(bytes(stored)).toBeGreaterThan(1024 * 1024 - 8)
    expect(text.startsWith(kept)).toBe(true)
    expect(content).toMatch(/…\n\n\[The stored copy of this result was reduced/)
  })

  it('appends no truncation marker when the whole text fits', () => {
    const parts = Array.from({ length: 20 }, (_, index) => `${index}`.padStart(10, '-'))
    const text = parts.join('')

    const expected = ToolResult.make({
      toolCallId: 'call_1',
      content: `${text}\n\n[The stored copy of this result was reduced to fit the tool ledger bound.]`
    })

    const maxBytes = new TextEncoder().encode(JSON.stringify(expected)).length

    // As 20 text parts the content does not fit; as one string (with the note) it does.
    const stored = toolLedgerResult(
      ToolResult.make({
        toolCallId: 'call_1',
        content: parts.map(part => TextPart.make({ text: part }))
      }),
      maxBytes
    )

    expect(stored).toEqual(expected)
  })

  it('drops nestedCalls before structuredContent when reducing a stored result', () => {
    const storeWrites = { set: { report: 'v'.repeat(500_000) }, delete: [] }

    const nestedCalls = NestedToolCalls.make({
      complete: true,
      calls: Array.from({ length: 600 }, (_, index) =>
        NestedToolCallRecord.make({
          id: `call_1/${index + 1}`,
          name: 'sales_manage',
          args: '{}',
          status: 'error',
          error: 'é'.repeat(500)
        })
      )
    })

    const stored = toolLedgerResult(
      ToolResult.make({
        toolCallId: 'call_1',
        content: 'done',
        structuredContent: { codemode: { ok: true, storeWrites } },
        nestedCalls
      })
    )

    expect(stored.structuredContent).toEqual({ codemode: { ok: true, storeWrites } })
    expect(stored.nestedCalls).toBeUndefined()
    expect(resultText(stored)).toContain('reduced to fit')
  })

  it.effect('stores bounded, wire-safe results that round-trip through the JSON codec', () =>
    Effect.gen(function* () {
      const big = ToolResult.make({
        toolCallId: 'call_1',
        content: [
          ImagePart.make({
            source: inlineBase64AttachmentSource('A'.repeat(4_000)),
            mimeType: 'image/png'
          })
        ],
        structuredContent: { at: new Date(0), skip: undefined, n: 1 }
      })

      const small = toolLedgerResult(big, 1_000)

      expect(small.content).toEqual([
        expect.objectContaining({ text: '[image omitted from the stored result]' }),
        expect.objectContaining({ text: expect.stringContaining('reduced to fit') })
      ])
      expect(small.structuredContent).toEqual({ at: '1970-01-01T00:00:00.000Z', n: 1 })
      expect(JSON.stringify(small).length).toBeLessThanOrEqual(1_000)

      const tiny = toolLedgerResult(
        ToolResult.make({ toolCallId: 'call_1', content: 'é'.repeat(5_000) }),
        2_000
      )

      expect(new TextEncoder().encode(JSON.stringify(tiny)).length).toBeLessThanOrEqual(2_000)

      const entry = ToolLedgerEntry.make({
        key: 'call_1',
        toolName: 'append_note',
        args: '{}',
        argsDigest: 'digest',
        argsTruncated: false,
        claimedAtMs: 1,
        leaseExpiresAtMs: 2,
        completedAtMs: 2,
        outcome: ToolLedgerSucceeded.make({ result: small })
      })

      const codec = Schema.toCodecJson(ToolLedgerEntry)
      const encoded = yield* Schema.encodeEffect(codec)(entry)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(JSON.stringify(encoded)))

      expect(decoded).toEqual(entry)
    })
  )
})
