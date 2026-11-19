import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  contentText,
  InteractionHostError,
  InteractionRequest,
  InteractionResponse,
  InteractionValidationError,
  interactionRequestId,
  inputRequiredNotice,
  makeInputRequiredToolResult,
  maxInputReviewPauses,
  mergeInputRequiredRefs,
  ToolCall,
  toolInputRequired,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  InputPauseResolution,
  InputReviewOutcome,
  inputReviewToolName,
  makeInputReviewTool,
  resolveTools,
  type InputPause,
  type InputPauseEntry,
  type InputReviewHost
} from '../../src/tools/index.ts'
import { makeFakeInteractionHost } from './interaction-host.ts'

type Ctx = { readonly tenant: string }

const context: Ctx = { tenant: 'tenant_1' }

type Pause = InputPause & { readonly confirm: boolean }

type Store = {
  readonly pauses: Map<string, Pause & { status: 'pending' | 'claimed' }>
  readonly resolutions: Map<string, InputPauseResolution>
  readonly resumed: Array<{ readonly id: string; readonly answer: Schema.Json }>
  down: boolean
  dieOn?: string
  refuse?: boolean
}

const makeStore = (ids: ReadonlyArray<string>): Store => ({
  pauses: new Map(
    ids.map(id => [id, { id, label: `Delete ${id}`, confirm: true, status: 'pending' }])
  ),
  resolutions: new Map(),
  resumed: [],
  down: false
})

const Confirm = Schema.Struct({ confirm: Schema.Literal(true) })

const host = (store: Store): InputReviewHost<Pause> => ({
  load: ids =>
    Effect.gen(function* () {
      if (store.down)
        return yield* Effect.fail(new InteractionHostError({ cause: 'storage', message: 'down' }))

      return yield* Effect.forEach(ids, id => {
        const pause = store.pauses.get(id)

        return pause === undefined || pause.status !== 'pending'
          ? Effect.fail(new InteractionValidationError({ message: `No pending pause ${id}` }))
          : Effect.succeed(pause)
      })
    }),
  validateAnswer: ({ answer }) =>
    Schema.decodeUnknownEffect(Confirm)(answer).pipe(
      Effect.asVoid,
      Effect.mapError(() => new InteractionValidationError({ message: 'Confirm to continue' }))
    ),
  resume: ({ pause, answer }) =>
    Effect.gen(function* () {
      const stored = store.pauses.get(pause.id)

      if (stored === undefined || stored.status !== 'pending')
        return InputPauseResolution.NotSent({ message: 'already answered' })

      if (store.refuse === true)
        return InputPauseResolution.NotSent({ message: 'the server moved' })

      stored.status = 'claimed'

      if (store.dieOn === pause.id) return yield* Effect.die(new Error('crashed'))

      store.resumed.push({ id: pause.id, answer })

      const resolution =
        pause.id === 'again'
          ? InputPauseResolution.InputRequired({ pauseIds: ['again-2'] })
          : InputPauseResolution.Completed({
              result: ToolResult.make({ toolCallId: 'original', content: `deleted ${pause.id}` })
            })

      store.resolutions.set(pause.id, resolution)

      return resolution
    }),
  recorded: ({ pauseIds }) =>
    Effect.succeed(
      pauseIds.map((id): InputPauseEntry => ({
        pause: { id, label: `Delete ${id}` },
        resolution: store.resolutions.get(id)
      }))
    )
})

const setup = (ids: ReadonlyArray<string>, settlement?: 'fail') =>
  Effect.gen(function* () {
    const store = makeStore(ids)
    const fake = makeFakeInteractionHost(settlement === undefined ? {} : { settlement })

    const toolSet = yield* resolveTools(
      [{ id: 'review', tools: [makeInputReviewTool<Ctx, Pause>({ host: host(store) })] }],
      context,
      { interactionHost: fake.host }
    )

    return { store, fake, toolSet }
  })

type Env = Effect.Success<ReturnType<typeof setup>>

const reviewCall = (pauseIds: ReadonlyArray<string>, id = 'review_1') =>
  ToolCall.make({ id, name: inputReviewToolName, params: { pauseIds: [...pauseIds] } })

const interactionOf = (env: Env) => {
  const interaction = env.toolSet.interactions[inputReviewToolName]

  if (interaction === undefined || interaction.def.interaction === undefined)
    throw new Error('Missing input review interaction')

  return { interaction, descriptor: interaction.def.interaction }
}

const accept = (env: Env, call: ToolCall, answers: Record<string, Schema.Json>) =>
  Effect.gen(function* () {
    const { interaction, descriptor } = interactionOf(env)

    env.fake.addPending(
      InteractionRequest.make({
        requestId: interactionRequestId(call),
        toolCallId: call.id,
        call,
        interaction: descriptor
      })
    )

    return yield* env.fake.accept(
      InteractionResponse.make({
        requestId: interactionRequestId(call),
        toolCallId: call.id,
        outcome: 'submitted',
        source: 'user',
        actionId: 'submit',
        data: { answers }
      }),
      interaction
    )
  })

const ReviewEnvelope = Schema.Struct({
  outcome: Schema.String,
  result: Schema.optional(InputReviewOutcome)
})

const outcomeOf = (result: ToolResult) =>
  Schema.decodeUnknownEffect(ReviewEnvelope)(result.structuredContent).pipe(Effect.orDie)

const textOf = (result: ToolResult) =>
  Predicate.isString(result.content) ? result.content : contentText(result.content)

describe('input-required results', () => {
  it('carry the review call and are read back as error results only', () => {
    const result = makeInputRequiredToolResult({
      toolCallId: 'call_1',
      content: 'Afloat asks to confirm deleting the expense.',
      reviewToolName: 'review_input',
      pauseIds: ['p1']
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('review_input({"pauseIds":["p1"]})')
    expect(toolInputRequired(result)).toEqual(
      Option.some({ reviewToolName: 'review_input', pauseIds: ['p1'] })
    )
    expect(toolInputRequired({ structuredContent: result.structuredContent })).toEqual(
      Option.none()
    )
    expect(toolInputRequired({ isError: true, structuredContent: { code: 'other' } })).toEqual(
      Option.none()
    )
  })

  it("splits a tool's pauses into reviews the review tool accepts, listing every one", () => {
    const ids = Array.from({ length: 6 * maxInputReviewPauses + 1 }, (_, index) => `p${index}`)
    const [first, ...rest] = ids

    if (first === undefined) return expect.fail('Expected pause ids')

    const merged = mergeInputRequiredRefs([
      { reviewToolName: 'review_input', pauseIds: [first, ...rest] }
    ])

    expect(merged.map(ref => ref.pauseIds.length)).toEqual([50, 50, 50, 50, 50, 50, 1])

    const notice = inputRequiredNotice(merged)

    expect(notice).toContain('301 calls need')
    expect(notice.split('\n').filter(line => line.startsWith('- review_input('))).toHaveLength(7)
  })

  it('merges refs per review tool without repeating pauses', () => {
    expect(
      mergeInputRequiredRefs([
        { reviewToolName: 'review_input', pauseIds: ['p1', 'p2'] },
        { reviewToolName: 'other', pauseIds: ['x'] },
        { reviewToolName: 'review_input', pauseIds: ['p2', 'p3'] }
      ])
    ).toEqual([
      { reviewToolName: 'review_input', pauseIds: ['p1', 'p2', 'p3'] },
      { reviewToolName: 'other', pauseIds: ['x'] }
    ])
  })
})

describe('makeInputReviewTool', () => {
  it.effect('is an interaction tool that never runs directly', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1'])
      const result = yield* env.toolSet.execute(reviewCall(['p1'])).pipe(Effect.flip)

      expect(interactionOf(env).descriptor.kind).toBe('input_review')
      expect(result.cause).toBe('unavailable')
    })
  )

  it.effect('validates the call against stored pending pauses, outages included', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1'])
      const { interaction } = interactionOf(env)

      yield* interaction.validateCall({ pauseIds: ['p1'] })

      const unknown = yield* interaction.validateCall({ pauseIds: ['made-up'] }).pipe(Effect.flip)
      const repeated = yield* interaction.validateCall({ pauseIds: ['p1', 'p1'] }).pipe(Effect.flip)

      env.store.down = true

      const outage = yield* interaction.validateCall({ pauseIds: ['p1'] }).pipe(Effect.flip)

      expect(unknown._tag).toBe('InteractionValidationError')
      expect(repeated._tag).toBe('InteractionValidationError')
      expect(outage._tag).toBe('InteractionHostError')
    })
  )

  it.effect('admits exactly one fitting answer per listed pause', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1', 'p2'])
      const { interaction } = interactionOf(env)
      const call = reviewCall(['p1', 'p2'])

      const check = (answers: Record<string, Schema.Json>) =>
        interaction.validateAction({ actionId: 'submit', data: { answers }, call })

      yield* check({ p1: { confirm: true }, p2: { confirm: true } })

      const missing = yield* check({ p1: { confirm: true } }).pipe(Effect.flip)

      const extra = yield* check({
        p1: { confirm: true },
        p2: { confirm: true },
        p3: { confirm: true }
      }).pipe(Effect.flip)

      const unfit = yield* check({ p1: { confirm: false }, p2: { confirm: true } }).pipe(
        Effect.flip
      )

      expect(missing.message).toContain('missing: p2')
      expect(extra.message).toContain('p3')
      expect(unfit.message).toBe('Confirm to continue')
      expect(env.store.resumed).toEqual([])
    })
  )

  it.effect('resumes each pause once and lists results and new pauses', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1', 'again'])
      const call = reviewCall(['p1', 'again'])
      const ref = yield* accept(env, call, { p1: { confirm: true }, again: { confirm: true } })
      const result = yield* env.toolSet.execute(call, { interaction: ref })
      const outcome = yield* outcomeOf(result)

      expect(outcome.outcome).toBe('completed')
      expect(outcome.result?.pauses.map(pause => [pause.pauseId, pause.status])).toEqual([
        ['p1', 'completed'],
        ['again', 'input_required']
      ])
      expect(outcome.result?.pauses[1]?.inputRequired).toEqual({
        reviewToolName: 'review_input',
        pauseIds: ['again-2']
      })
      expect(textOf(result)).toContain('deleted p1')
      expect(textOf(result)).toContain('review_input({"pauseIds":["again-2"]})')
      expect(env.store.resumed.map(item => item.id)).toEqual(['p1', 'again'])

      // A replay of the settled review returns its result and sends nothing again.
      const replayed = yield* env.toolSet.execute(call, { interaction: ref })

      expect(textOf(replayed)).toBe(textOf(result))
      expect(env.store.resumed).toHaveLength(2)
    })
  )

  it.effect('reports a review whose pauses were all refused as failed', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1'])
      const call = reviewCall(['p1'])
      const ref = yield* accept(env, call, { p1: { confirm: true } })

      // The target changed between admission and execution: the host refuses to send.
      env.store.refuse = true

      const result = yield* env.toolSet.execute(call, { interaction: ref })
      const outcome = yield* outcomeOf(result)

      expect(outcome.outcome).toBe('failed')
      expect(textOf(result)).toContain('not sent: the server moved')
      expect(env.store.resumed).toEqual([])
    })
  )

  it.effect('replays a review whose every pause was recorded as its proven outcome', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1'], 'fail')
      const call = reviewCall(['p1'])
      const ref = yield* accept(env, call, { p1: { confirm: true } })

      // Every pause resolved; only the receipt's settlement was lost.
      yield* env.toolSet.execute(call, { interaction: ref }).pipe(Effect.exit)

      const replayed = yield* env.toolSet.execute(call, { interaction: ref })
      const outcome = yield* outcomeOf(replayed)

      expect(outcome.outcome).toBe('completed')
      expect(outcome.result?.interrupted).toBe(true)
      expect(outcome.result?.pauses.map(pause => pause.status)).toEqual(['completed'])
      expect(env.store.resumed.map(item => item.id)).toEqual(['p1'])
    })
  )

  it.effect('lists recorded resolutions after a crash, as unknown, without sending again', () =>
    Effect.gen(function* () {
      const env = yield* setup(['p1', 'p2'], 'fail')

      env.store.dieOn = 'p2'

      const call = reviewCall(['p1', 'p2'])
      const ref = yield* accept(env, call, { p1: { confirm: true }, p2: { confirm: true } })

      yield* env.toolSet.execute(call, { interaction: ref }).pipe(Effect.exit)

      const replayed = yield* env.toolSet.execute(call, { interaction: ref })
      const outcome = yield* outcomeOf(replayed)

      expect(replayed.isError).toBe(true)
      expect(outcome.outcome).toBe('unknown')
      expect(outcome.result?.interrupted).toBe(true)
      expect(outcome.result?.pauses.map(pause => [pause.pauseId, pause.status])).toEqual([
        ['p1', 'completed'],
        ['p2', 'unknown']
      ])
      expect(env.store.resumed.map(item => item.id)).toEqual(['p1'])
    })
  )
})
