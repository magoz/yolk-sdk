import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  ToolApprovalPolicy,
  ToolCall,
  ToolResult,
  type InteractionHost
} from '@yolk-sdk/agent/protocol'
import {
  makeInMemoryToolLedgerStore,
  makeInMemoryToolPlanStore,
  makePlanReviewTool,
  makeTool,
  resolveTools,
  type ToolLedgerOptions,
  type ToolModule,
  type ToolPlanOptions,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import {
  makeCodeModeTool,
  type CodeModeExecutor,
  type MakeCodeModeToolOptions
} from '../src/index.ts'
import { makePiCodeModeExecutor } from '../src/node.ts'
import { context, moduleOf, queryTool, text, type TestContext } from './fixtures.ts'

type Call = (name: string, args?: unknown) => Promise<unknown>

type Stage = (name: string, args?: unknown) => Promise<unknown>

/** A fake engine running a host-side script over the executor's tools and its `stage` global. */
const scriptedExecutor = (script: (call: Call, stage: Stage) => Promise<unknown>) => {
  const state = { globals: Array<string>() }

  const executor: CodeModeExecutor = {
    execute: (_code, options) => {
      state.globals = options.globals.map(global => global.name)

      const call: Call = (name, args) => {
        const tool = options.tools.find(candidate => candidate.name === name)

        return tool === undefined
          ? Promise.reject(new Error(`unknown tool ${name}`))
          : tool.execute(args, { signal: options.signal })
      }

      const stage: Stage = (name, args) => {
        const global = options.globals.find(candidate => candidate.name === 'stage')

        return global === undefined
          ? Promise.reject(new Error('stage is not defined'))
          : global.execute([name, args], { signal: options.signal })
      }

      return script(call, stage).then(
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

const Link = Schema.Struct({ resource: Schema.String, curriculum: Schema.String })

const linkTool = (applied: Array<string>): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof Link>({
    name: 'link_curriculum',
    description: 'Link a curriculum',
    parameters: Link,
    access: 'write',
    approval: ToolApprovalPolicy.make({ mode: 'manual' }),
    staging: true,
    execute: ({ call, params }) =>
      Effect.sync(() => {
        applied.push(params.resource)

        return ToolResult.make({ toolCallId: call.id, content: 'linked' })
      })
  })

const NoteParams = Schema.Struct({ note: Schema.String })

const noteTool = (notes: Array<string>): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof NoteParams>({
    name: 'note',
    description: 'Write a note',
    parameters: NoteParams,
    access: 'write',
    execute: ({ call, params }) =>
      Effect.sync(() => {
        notes.push(params.note)

        return ToolResult.make({ toolCallId: call.id, content: 'noted' })
      })
  })

// Staging needs a receipt port; these tests never open a review, so it is never called.
const unusedHost: InteractionHost = {
  read: () => Effect.succeed(undefined),
  claim: () => Effect.die('unused'),
  settle: () => Effect.die('unused')
}

type ResolveOptionFields = {
  interactionHost: InteractionHost
  plans?: ToolPlanOptions
  ledger?: ToolLedgerOptions
}

const stagingSetup = (
  script: (call: Call, stage: Stage) => Promise<unknown>,
  options: {
    readonly plans?: boolean
    readonly ledger?: boolean
    readonly codemode?: Partial<MakeCodeModeToolOptions<TestContext>>
  } = {}
) =>
  Effect.gen(function* () {
    const { executor, state } = scriptedExecutor(script)
    const store = makeInMemoryToolPlanStore({ scope: 'conversation_1' })
    const ledgerStore = makeInMemoryToolLedgerStore()
    const applied: Array<string> = []
    const notes: Array<string> = []

    const modules: ReadonlyArray<ToolModule<TestContext>> = [
      moduleOf('host', [
        makeCodeModeTool<TestContext>({ executor, ...options.codemode }),
        makePlanReviewTool<TestContext>()
      ]),
      moduleOf('cms', [linkTool(applied), noteTool(notes), queryTool('lookup')])
    ]

    const resolveOptions: ResolveOptionFields = { interactionHost: unusedHost }

    if (options.plans !== false) resolveOptions.plans = { store }

    if (options.ledger === true) resolveOptions.ledger = { store: ledgerStore }

    const toolSet = yield* resolveTools(modules, context, resolveOptions)

    const run = (id = 'call_1') =>
      toolSet.execute(ToolCall.make({ id, name: 'codemode', params: { code: 'script' } }))

    return { toolSet, store, ledgerStore, applied, notes, state, run }
  })

const CodeModePlanResult = Schema.Struct({
  codemode: Schema.Struct({
    ok: Schema.Boolean,
    plan: Schema.optional(
      Schema.Struct({
        id: Schema.String,
        digest: Schema.String,
        count: Schema.Number,
        reviewToolName: Schema.String
      })
    )
  })
})

const codemodeOf = (result: ToolResult) =>
  Schema.decodeUnknownEffect(CodeModePlanResult)(result.structuredContent).pipe(
    Effect.map(decoded => decoded.codemode),
    Effect.orDie
  )

describe('code mode staging', () => {
  it.effect('stages calls into one saved plan and runs none of them', () =>
    Effect.gen(function* () {
      const env = yield* stagingSetup(async (call, stage) => {
        const found = await call('lookup', { query: 'published' })
        const receipts = []

        for (const resource of ['r1', 'r2', 'r3']) {
          receipts.push(await stage('link_curriculum', { resource, curriculum: 'LGR22' }))
        }

        return { found, receipts }
      })

      const result = yield* env.run()
      const codemode = yield* codemodeOf(result)
      const stored = yield* env.store.get('call_1')

      expect(result.isError).toBeUndefined()
      expect(env.state.globals).toContain('stage')
      expect(env.applied).toEqual([])
      expect(stored?.plan.calls.map(staged => staged.key)).toEqual([
        'call_1/s1',
        'call_1/s2',
        'call_1/s3'
      ])
      expect(codemode.plan).toEqual({
        id: 'call_1',
        digest: stored?.plan.digest,
        count: 3,
        reviewToolName: 'review_plan'
      })
      expect(text(result.content)).toContain(
        `Staged 3 calls as plan call_1; nothing was applied yet. To apply them, call review_plan({"planId":"call_1","planDigest":"${stored?.plan.digest}"})`
      )
      expect(text(result.content)).toContain('{"staged":true,"key":"call_1/s1","index":1}')
      expect(result.nestedCalls?.calls.map(nested => nested.name)).toEqual(['lookup'])
    })
  )

  it.effect('describes stage() and the stageable tools only when staging is offered', () =>
    Effect.gen(function* () {
      const staged = yield* stagingSetup(() => Promise.resolve(undefined))
      const plain = yield* stagingSetup(() => Promise.resolve(undefined), { plans: false })

      const off = yield* stagingSetup(() => Promise.resolve(undefined), {
        codemode: { staging: false }
      })

      const description = (toolSet: typeof staged.toolSet) =>
        toolSet.tools.find(tool => tool.name === 'codemode')?.description ?? ''

      expect(description(staged.toolSet)).toContain('`await stage(name, args)`')
      expect(description(staged.toolSet)).toContain('## Stageable tools')
      expect(description(staged.toolSet)).toContain('- `link_curriculum`')
      expect(description(staged.toolSet)).toContain('`review_plan`')
      expect(description(plain.toolSet)).not.toContain('stage(')
      expect(description(off.toolSet)).not.toContain('stage(')

      yield* plain.run()
      yield* off.run()

      expect(plain.state.globals).not.toContain('stage')
      expect(off.state.globals).not.toContain('stage')
    })
  )

  it.effect('keeps approval tools fail-closed through tools.<name>()', () =>
    Effect.gen(function* () {
      const env = yield* stagingSetup(call =>
        call('link_curriculum', { resource: 'r1', curriculum: 'x' })
      )

      const result = yield* env.run()

      expect(result.isError).toBe(true)
      expect(text(result.content)).toContain('unknown tool link_curriculum')
      expect(env.applied).toEqual([])
    })
  )

  it.effect('discards the staged calls of a failed script', () =>
    Effect.gen(function* () {
      const env = yield* stagingSetup(async (_call, stage) => {
        await stage('link_curriculum', { resource: 'r1', curriculum: 'LGR22' })

        throw new Error('changed my mind')
      })

      const result = yield* env.run()

      expect(result.isError).toBe(true)
      expect(text(result.content)).toContain('its 1 staged call was discarded; nothing was applied')
      expect((yield* codemodeOf(result)).plan).toBeUndefined()
      expect(yield* env.store.get('call_1')).toBeUndefined()
    })
  )

  it.effect('rejects writes after staging and staging after writes inside the script', () =>
    Effect.gen(function* () {
      const writeAfter = yield* stagingSetup(async (call, stage) => {
        await stage('link_curriculum', { resource: 'r1', curriculum: 'LGR22' })
        await call('lookup', { query: 'reads are fine' })

        return call('note', { note: 'too late' }).catch((error: unknown) => String(error))
      })

      const stageAfter = yield* stagingSetup(async (call, stage) => {
        await call('note', { note: 'first' })

        return stage('link_curriculum', { resource: 'r1', curriculum: 'LGR22' }).catch(
          (error: unknown) => String(error)
        )
      })

      const afterResult = yield* writeAfter.run()
      const stageResult = yield* stageAfter.run()

      expect(text(afterResult.content)).toContain('note cannot run after calls were staged')
      expect(writeAfter.notes).toEqual([])
      expect(afterResult.nestedCalls?.calls.map(nested => [nested.name, nested.status])).toEqual([
        ['lookup', 'ok'],
        ['note', 'error']
      ])
      expect((yield* codemodeOf(afterResult)).plan?.count).toBe(1)
      expect(text(stageResult.content)).toContain('stage: stage() is not allowed after note ran')
      expect(stageAfter.notes).toEqual(['first'])
      expect((yield* codemodeOf(stageResult)).plan).toBeUndefined()
    })
  )

  it.effect('rejects invalid, duplicate, and over-limit stages in the script', () =>
    Effect.gen(function* () {
      const env = yield* stagingSetup(
        async (_call, stage) => {
          const errors: Array<string> = []

          const attempt = (name: string, args: unknown) =>
            stage(name, args).catch((error: unknown) => {
              errors.push(String(error))
            })

          await attempt('link_curriculum', { resource: 'r1', curriculum: 'LGR22' })
          await attempt('link_curriculum', { resource: 'r1', curriculum: 'LGR22' })
          await attempt('link_curriculum', { resource: 1 })
          await attempt('note', { note: 'x' })
          await attempt('link_curriculum', { resource: 'r2', curriculum: 'LGR22' })
          await attempt('link_curriculum', { resource: 'r3', curriculum: 'LGR22' })

          return errors
        },
        { codemode: { staging: { maxCalls: 2 } } }
      )

      const result = yield* env.run()
      const output = text(result.content)

      expect(output).toContain('already staged as call_1/s1')
      expect(output).toContain('Invalid link_curriculum arguments')
      expect(output).toContain('note cannot be staged')
      expect(output).toContain('a plan holds at most 2 calls')
      expect((yield* codemodeOf(result)).plan?.count).toBe(2)
    })
  )

  it.effect('never re-runs a ledgered script: the replay returns the same plan', () =>
    Effect.gen(function* () {
      let runs = 0

      const env = yield* stagingSetup(
        async (_call, stage) => {
          runs++

          return stage('link_curriculum', { resource: 'r1', curriculum: 'LGR22' })
        },
        { ledger: true }
      )

      const first = yield* env.run()
      const second = yield* env.run()

      expect(runs).toBe(1)
      expect(second.content).toEqual(first.content)
      expect((yield* codemodeOf(second)).plan).toEqual((yield* codemodeOf(first)).plan)
      expect(yield* env.store.plans).toHaveLength(1)
    })
  )

  it.live('stages through the real pi executor', () =>
    Effect.gen(function* () {
      const env = yield* stagingSetup(() => Promise.resolve(undefined), {
        codemode: { executor: makePiCodeModeExecutor() }
      })

      const result = yield* env.toolSet.execute(
        ToolCall.make({
          id: 'call_pi',
          name: 'codemode',
          params: {
            code: `const keys = []
              for (const resource of ['r1', 'r2']) {
                const receipt = await stage('link_curriculum', { resource, curriculum: 'LGR22' })
                keys.push(receipt.key)
              }
              const rejected = await stage('note', { note: 'x' }).catch(error => error.message)
              return { keys, rejected }`
          }
        })
      )

      expect(result.isError).toBeUndefined()
      expect(text(result.content)).toContain('"keys":["call_pi/s1","call_pi/s2"]')
      expect(text(result.content)).toContain('stage: note cannot be staged')
      expect((yield* codemodeOf(result)).plan?.count).toBe(2)
      expect(env.applied).toEqual([])
    })
  )

  it.effect('reports a plan that cannot be saved as a failed script', () =>
    Effect.gen(function* () {
      const env = yield* stagingSetup(async (_call, stage) =>
        stage('link_curriculum', { resource: 'r2', curriculum: 'LGR22' })
      )

      // A different plan already holds this id (for example a changed re-run without a ledger).
      yield* stagingSetup(async (_call, stage) =>
        stage('link_curriculum', { resource: 'r1', curriculum: 'LGR22' })
      ).pipe(
        Effect.flatMap(other =>
          other.run().pipe(
            Effect.flatMap(() => other.store.get('call_1')),
            Effect.flatMap(stored =>
              stored === undefined ? Effect.void : env.store.put(stored.plan)
            )
          )
        )
      )

      const result = yield* env.run()

      expect(result.isError).toBe(true)
      expect(yield* codemodeOf(result)).toEqual({ ok: false })
      expect(text(result.content)).toContain('the plan could not be saved')
    })
  )
})
