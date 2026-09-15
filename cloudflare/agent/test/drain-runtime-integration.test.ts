import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  FauxExhaustedError,
  LLMError,
  LLMProvider,
  LLMTextDelta,
  makeAgentLoopLayer,
  ToolExecutor,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { Reply } from '@yolk-sdk/agent/loop/testing'
import {
  appendRuntimeSessionEventsToLog,
  HitlResponseAppended,
  InputAppended,
  latestIncompleteRuntimeRun,
  replayRuntimeSessionEvents,
  runRuntime,
  RunStarted,
  SessionConflictError,
  type RuntimeConfig,
  type RuntimeSessionEventLog
} from '@yolk-sdk/agent/runtime'
import {
  AgentMessage,
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  SessionSnapshot,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  ToolResult,
  UserMessage,
  type AgentEvent,
  type HitlRequest
} from '@yolk-sdk/agent/protocol'
import { Driver, type DriverApi } from '@yolk-sdk/harness/driver'
import { makeDurableObjectDriverLayer } from '@yolk-sdk/harness/driver/durable-object'
import { RunStore, type DurableRunStoreSnapshot } from '@yolk-sdk/harness/store'
import { makeLiveDrain } from '../src/drain-lifecycle.ts'
import {
  emptyRuntimeEventLog,
  interruptLatestIncompleteRun,
  loadRuntimeEventLogOrEmpty,
  makeDurableObjectSessionEventStoreLayer
} from '../src/session-event-storage.ts'

const sessionId = 'session_cloudflare_1'

const orphanResumeCount = 2

const runtimeConfig: RuntimeConfig = {
  systemPrompt: 'Cloudflare composition test agent.',
  tools: [],
  model: 'faux-cloudflare'
}

const weatherTool = ToolDef.make({
  name: 'weather',
  description: 'Get weather.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
})

const weatherConfig: RuntimeConfig = {
  ...runtimeConfig,
  tools: [weatherTool]
}

const weatherCall = ToolCall.make({
  id: 'call_1',
  name: 'weather',
  params: { city: 'Paris' }
})

const weatherAssistant = AssistantAgentMessage.make({
  parts: [HostToolCallPart.make({ call: weatherCall })]
})

const successorAssistant = AssistantAgentMessage.make({
  parts: [AssistantTextPart.make({ content: 'successor done' })]
})

const explicitAssistant = AssistantAgentMessage.make({
  parts: [AssistantTextPart.make({ content: 'explicit resume' })]
})

const sunnyAssistant = AssistantAgentMessage.make({
  parts: [AssistantTextPart.make({ content: 'sunny' })]
})

type ScriptedTurn = (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>

type LiveDrain = ReturnType<typeof makeLiveDrain> extends Effect.Effect<infer A> ? A : never

const eventTags = (log: RuntimeSessionEventLog) => log.events.map(stored => stored.event._tag)

const requireStoredEvent = (log: RuntimeSessionEventLog, tag: string) => {
  const stored = log.events.find(item => item.event._tag === tag)

  if (stored === undefined) {
    throw new Error(`Expected ${tag} in runtime log, got [${eventTags(log).join(', ')}]`)
  }

  return stored
}

const runIds = (
  log: RuntimeSessionEventLog,
  tag: 'RunStarted' | 'RunCompleted' | 'RunInterrupted' | 'RunFailed'
) => log.events.flatMap(stored => (stored.event._tag === tag ? [stored.event.runId] : []))

const requireToolResult = (messages: ReadonlyArray<AgentMessage>) => {
  const result = messages.find(message => message._tag === 'ToolResult')

  if (result === undefined) {
    throw new Error('Expected ToolResult in completed messages')
  }

  return result
}

const cloneValue = <A>(value: A): A => structuredClone(value)

const makeCloningStores = () =>
  Effect.gen(function* () {
    const harness = yield* Ref.make<DurableRunStoreSnapshot | undefined>(undefined)
    const events = yield* Ref.make<RuntimeSessionEventLog | undefined>(undefined)

    return {
      harness: {
        load: Ref.get(harness).pipe(
          Effect.map(value => (value === undefined ? undefined : cloneValue(value)))
        ),
        save: (snapshot: DurableRunStoreSnapshot) => Ref.set(harness, cloneValue(snapshot))
      },
      events: {
        get: () =>
          Ref.get(events).pipe(
            Effect.map(value => (value === undefined ? undefined : cloneValue(value)))
          ),
        put: (log: RuntimeSessionEventLog) => Ref.set(events, cloneValue(log))
      }
    }
  })

const delayedHarnessSave = (
  save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>,
  delayRelease: {
    readonly enabled: Ref.Ref<boolean>
    readonly entered: Deferred.Deferred<void>
    readonly hold: Deferred.Deferred<void>
  }
) => ({
  save: (snapshot: DurableRunStoreSnapshot) =>
    Ref.get(delayRelease.enabled).pipe(
      Effect.flatMap(enabled =>
        enabled && snapshot.claimed.length === 0
          ? Deferred.succeed(delayRelease.entered, undefined).pipe(
              Effect.andThen(Deferred.await(delayRelease.hold)),
              Effect.andThen(save(snapshot))
            )
          : save(snapshot)
      )
    )
})

const makeScriptedProviderLayer = (
  scripts: Ref.Ref<ReadonlyArray<ScriptedTurn>>,
  requests: Ref.Ref<ReadonlyArray<LLMRequest>>
) =>
  Layer.succeed(
    LLMProvider,
    LLMProvider.of({
      stream: request =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(requests, current => [...current, request])
            const current = yield* Ref.get(scripts)
            const next = current[0]

            if (next === undefined) {
              return yield* Effect.fail(
                new FauxExhaustedError({ message: 'No more scripted provider turns' })
              )
            }

            yield* Ref.set(scripts, current.slice(1))

            return next(request)
          })
        )
    })
  )

const makeRecordingToolLayer = (executed: Ref.Ref<ReadonlyArray<ToolCall>>) =>
  Layer.succeed(
    ToolExecutor,
    ToolExecutor.of({
      execute: call =>
        Ref.update(executed, current => [...current, call]).pipe(
          Effect.andThen(Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '72F' })))
        )
    })
  )

const makeRuntimeLayer = (input: {
  readonly eventStorage: {
    readonly get: () => Effect.Effect<RuntimeSessionEventLog | undefined>
    readonly put: (log: RuntimeSessionEventLog) => Effect.Effect<void>
  }
  readonly scripts: Ref.Ref<ReadonlyArray<ScriptedTurn>>
  readonly requests: Ref.Ref<ReadonlyArray<LLMRequest>>
  readonly executedTools: Ref.Ref<ReadonlyArray<ToolCall>>
}) =>
  Layer.mergeAll(
    makeAgentLoopLayer({
      provider: makeScriptedProviderLayer(input.scripts, input.requests),
      tools: makeRecordingToolLayer(input.executedTools)
    }),
    makeDurableObjectSessionEventStoreLayer(sessionId, input.eventStorage)
  )

const hydrateSnapshot = (log: RuntimeSessionEventLog) =>
  Schema.decodeUnknownEffect(Schema.Array(AgentMessage))(
    replayRuntimeSessionEvents(log.events)
  ).pipe(
    Effect.map(messages =>
      SessionSnapshot.make({
        revision: log.revision,
        messages
      })
    )
  )

const startOwnedAppend = (input: {
  readonly live: LiveDrain
  readonly driver: DriverApi
  readonly eventStorage: {
    readonly get: () => Effect.Effect<RuntimeSessionEventLog | undefined>
    readonly put: (log: RuntimeSessionEventLog) => Effect.Effect<void>
  }
  readonly socketId: string
  readonly runId: string
  readonly request:
    | { readonly _tag: 'AppendInput'; readonly sessionId: string; readonly input: UserMessage }
    | {
        readonly _tag: 'AppendHitlResponse'
        readonly sessionId: string
        readonly response: ReturnType<typeof ToolApprovalResponse.make>
        readonly expectedRevision?: number
      }
  readonly config: RuntimeConfig
  readonly runtimeLayer: ReturnType<typeof makeRuntimeLayer>
  readonly observedEvents: Ref.Ref<ReadonlyArray<AgentEvent>>
  readonly lastError: Ref.Ref<unknown>
}) =>
  Effect.gen(function* () {
    const prepareEpoch = yield* input.live.beginPrepare()

    const work = runRuntime({ ...input.request, runId: input.runId }, input.config).pipe(
      Stream.tap(event => Ref.update(input.observedEvents, current => [...current, event])),
      Stream.runDrain,
      Effect.tapError(error => Ref.set(input.lastError, error)),
      Effect.catch(() => Effect.void),
      Effect.provide(input.runtimeLayer)
    )

    return yield* input.live.runOwned(prepareEpoch, input.socketId, work, input.driver, sessionId)
  })

const withFreshHarness = <A, E, R>(
  input: {
    readonly live: LiveDrain
    readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
    readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
    readonly drainStarts: Ref.Ref<number>
  },
  use: (services: {
    readonly driver: DriverApi
    readonly store: RunStore['Service']
  }) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const driver = yield* Driver
    const store = yield* RunStore

    return yield* use({ driver, store })
  }).pipe(
    Effect.provide(
      makeDurableObjectDriverLayer({
        load: input.load,
        save: input.save,
        drain: () =>
          Ref.update(input.drainStarts, count => count + 1).pipe(Effect.andThen(input.live.runHeld))
      })
    )
  )

const waitingApprovalRequest = (log: RuntimeSessionEventLog): HitlRequest => {
  const stored = requireStoredEvent(log, 'RunAwaitingInput')

  if (stored.event._tag !== 'RunAwaitingInput') {
    throw new Error('Expected RunAwaitingInput event payload')
  }

  const request = stored.event.requests[0]

  if (request === undefined) {
    throw new Error('Expected a persisted HITL request')
  }

  return request
}

const failedError = (log: RuntimeSessionEventLog) => {
  const stored = requireStoredEvent(log, 'RunFailed')

  if (stored.event._tag !== 'RunFailed') {
    throw new Error('Expected RunFailed event payload')
  }

  return stored.event.error
}

const releaseHolds = (
  providerHold: Deferred.Deferred<void>,
  releaseHold: Deferred.Deferred<void>
) =>
  Effect.zip(Deferred.done(providerHold, Exit.void), Deferred.done(releaseHold, Exit.void)).pipe(
    Effect.asVoid
  )

describe('Cloudflare drain-runtime composition', () => {
  it.effect(
    'interrupts a live runtime, settles the Driver claim, finalizes on reconnect, then accepts new input',
    () =>
      Effect.gen(function* () {
        const stores = yield* makeCloningStores()
        const live = yield* makeLiveDrain()
        const drainStarts = yield* Ref.make(0)
        const requests = yield* Ref.make<ReadonlyArray<LLMRequest>>([])
        const executedTools = yield* Ref.make<ReadonlyArray<ToolCall>>([])
        const observedEvents = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
        const lastError = yield* Ref.make<unknown>(undefined)
        const providerEntered = yield* Deferred.make<void>()
        const providerHold = yield* Deferred.make<void>()
        const releaseEntered = yield* Deferred.make<void>()
        const releaseHold = yield* Deferred.make<void>()
        const delayEnabled = yield* Ref.make(false)
        const queuedWorkStarted = yield* Ref.make(false)
        const queuedAttempted = yield* Deferred.make<void>()

        const scripts = yield* Ref.make<ReadonlyArray<ScriptedTurn>>([
          () =>
            Stream.fromIterable([LLMTextDelta.make({ text: 'partial' })]).pipe(
              Stream.concat(
                Stream.unwrap(
                  Deferred.succeed(providerEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(providerHold)),
                    Effect.as(Stream.fromIterable(Reply.text('should-not-persist').events))
                  )
                )
              )
            ),
          () => Stream.fromIterable(Reply.text('successor done').events)
        ])

        const runtimeLayer = makeRuntimeLayer({
          eventStorage: stores.events,
          scripts,
          requests,
          executedTools
        })

        const harnessSave = delayedHarnessSave(stores.harness.save, {
          enabled: delayEnabled,
          entered: releaseEntered,
          hold: releaseHold
        }).save

        const firstInput = UserMessage.make({ content: 'live interrupt' })
        const successorInput = UserMessage.make({ content: 'fresh input' })

        yield* withFreshHarness(
          {
            live,
            load: stores.harness.load,
            save: harnessSave,
            drainStarts
          },
          ({ driver, store }) =>
            Effect.gen(function* () {
              const running = yield* startOwnedAppend({
                live,
                driver,
                eventStorage: stores.events,
                socketId: 'sock_live',
                runId: 'run_live_1',
                request: { _tag: 'AppendInput', sessionId, input: firstInput },
                config: runtimeConfig,
                runtimeLayer,
                observedEvents,
                lastError
              }).pipe(Effect.forkChild)

              yield* Deferred.await(providerEntered)
              const oldEpoch = yield* live.beginPrepare()
              const liveLog = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(liveLog)).toEqual(['InputAppended', 'RunStarted'])
              expect(liveLog.revision).toBe(2)
              expect(runIds(liveLog, 'RunStarted')).toEqual(['run_live_1'])
              expect(replayRuntimeSessionEvents(liveLog.events)).toEqual([firstInput])
              expect(yield* store.isClaimed(sessionId)).toBe(true)
              expect(yield* driver.isActive(sessionId)).toBe(true)
              expect((yield* Ref.get(requests)).map(request => request.messages)).toEqual([
                [firstInput]
              ])
              expect(yield* Ref.get(executedTools)).toEqual([])
              expect(
                (yield* Ref.get(observedEvents)).some(
                  event => event._tag === 'LLMTextDelta' && event.text === 'partial'
                )
              ).toBe(true)

              yield* Ref.set(delayEnabled, true)

              const reconnecting = yield* live
                .reconnect(
                  driver,
                  sessionId,
                  interruptLatestIncompleteRun(sessionId, stores.events)
                )
                .pipe(Effect.forkChild)

              yield* Deferred.await(releaseEntered)

              const queued = yield* Deferred.succeed(queuedAttempted, undefined).pipe(
                Effect.andThen(
                  live.runOwned(
                    oldEpoch,
                    'sock_blocked',
                    Ref.set(queuedWorkStarted, true),
                    driver,
                    sessionId
                  )
                ),
                Effect.forkChild
              )

              yield* Deferred.await(queuedAttempted)
              yield* Effect.yieldNow

              expect(reconnecting.pollUnsafe()).toBeUndefined()
              expect(queued.pollUnsafe()).toBeUndefined()
              expect(yield* Ref.get(queuedWorkStarted)).toBe(false)
              expect((yield* Ref.get(requests)).length).toBe(1)
              expect(yield* Ref.get(executedTools)).toEqual([])
              expect(
                eventTags(yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events))
              ).toEqual(['InputAppended', 'RunStarted'])
              expect(yield* store.isClaimed(sessionId)).toBe(true)
              expect(yield* driver.isActive(sessionId)).toBe(true)

              yield* Deferred.succeed(releaseHold, undefined)
              yield* Fiber.join(reconnecting)
              expect(yield* Fiber.join(queued)).toEqual({ _tag: 'Stale' })
              expect(yield* Ref.get(queuedWorkStarted)).toBe(false)
              const ownerExit = yield* Fiber.join(running).pipe(Effect.exit)
              expect(Exit.isFailure(ownerExit) && Cause.hasInterruptsOnly(ownerExit.cause)).toBe(
                true
              )

              const finalized = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(finalized)).toEqual([
                'InputAppended',
                'RunStarted',
                'RunInterrupted'
              ])
              expect(finalized.revision).toBe(3)
              expect(runIds(finalized, 'RunStarted')).toEqual(['run_live_1'])
              expect(runIds(finalized, 'RunInterrupted')).toEqual(['run_live_1'])
              expect(replayRuntimeSessionEvents(finalized.events)).toEqual([firstInput])
              expect(yield* store.isClaimed(sessionId)).toBe(false)
              expect(yield* driver.isActive(sessionId)).toBe(false)
              expect(yield* Ref.get(lastError)).toBeUndefined()

              const successor = yield* startOwnedAppend({
                live,
                driver,
                eventStorage: stores.events,
                socketId: 'sock_successor',
                runId: 'run_successor_1',
                request: { _tag: 'AppendInput', sessionId, input: successorInput },
                config: runtimeConfig,
                runtimeLayer,
                observedEvents,
                lastError
              })

              expect(successor._tag).toBe('Accepted')
              expect(yield* Ref.get(lastError)).toBeUndefined()

              const completed = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(completed)).toEqual([
                'InputAppended',
                'RunStarted',
                'RunInterrupted',
                'InputAppended',
                'RunStarted',
                'RunCompleted'
              ])
              expect(completed.revision).toBe(6)
              expect(runIds(completed, 'RunStarted')).toEqual(['run_live_1', 'run_successor_1'])
              expect(runIds(completed, 'RunInterrupted')).toEqual(['run_live_1'])
              expect(runIds(completed, 'RunCompleted')).toEqual(['run_successor_1'])
              expect(replayRuntimeSessionEvents(completed.events)).toEqual([
                firstInput,
                successorInput,
                successorAssistant
              ])
              const successorRequest = (yield* Ref.get(requests))[1]

              if (successorRequest === undefined) {
                throw new Error('Expected successor provider request')
              }

              expect(successorRequest.messages).toEqual([firstInput, successorInput])
              expect(yield* store.isClaimed(sessionId)).toBe(false)
              expect(yield* driver.isActive(sessionId)).toBe(false)
              expect(yield* Ref.get(executedTools)).toEqual([])
              expect((yield* Ref.get(requests)).length).toBe(2)
            }).pipe(Effect.ensuring(releaseHolds(providerHold, releaseHold)))
        )
      })
  )

  it.effect(
    'reconstructs fresh lifecycle and Driver over a seeded claim and incomplete log without auto work',
    () =>
      Effect.gen(function* () {
        const stores = yield* makeCloningStores()
        const orphanedInput = UserMessage.make({ content: 'orphaned' })
        yield* stores.events.put(
          appendRuntimeSessionEventsToLog(emptyRuntimeEventLog(sessionId), {
            sessionId,
            events: [
              InputAppended.make({ message: orphanedInput }),
              RunStarted.make({ runId: 'run_orphaned_1' })
            ]
          })
        )
        yield* stores.harness.save({
          claimed: [sessionId],
          resumes: [[sessionId, orphanResumeCount]]
        })

        const live = yield* makeLiveDrain()
        const drainStarts = yield* Ref.make(0)
        const requests = yield* Ref.make<ReadonlyArray<LLMRequest>>([])
        const executedTools = yield* Ref.make<ReadonlyArray<ToolCall>>([])
        const observedEvents = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
        const lastError = yield* Ref.make<unknown>(undefined)

        const scripts = yield* Ref.make<ReadonlyArray<ScriptedTurn>>([
          () => Stream.fromIterable(Reply.text('explicit resume').events)
        ])

        const runtimeLayer = makeRuntimeLayer({
          eventStorage: stores.events,
          scripts,
          requests,
          executedTools
        })

        const nextInput = UserMessage.make({ content: 'explicit next' })

        yield* withFreshHarness(
          {
            live,
            load: stores.harness.load,
            save: stores.harness.save,
            drainStarts
          },
          ({ driver, store }) =>
            Effect.gen(function* () {
              expect(yield* Ref.get(drainStarts)).toBe(0)
              expect(yield* Ref.get(requests)).toEqual([])
              expect(yield* Ref.get(executedTools)).toEqual([])
              expect(yield* store.isClaimed(sessionId)).toBe(true)
              expect(yield* store.resumeCount(sessionId)).toBe(orphanResumeCount)
              expect(yield* driver.isActive(sessionId)).toBe(false)
              expect(
                Option.isSome(
                  latestIncompleteRuntimeRun(
                    (yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)).events
                  )
                )
              ).toBe(true)

              yield* live.reconnect(
                driver,
                sessionId,
                interruptLatestIncompleteRun(sessionId, stores.events)
              )
              const once = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(once)).toEqual(['InputAppended', 'RunStarted', 'RunInterrupted'])
              expect(once.revision).toBe(3)
              expect(runIds(once, 'RunStarted')).toEqual(['run_orphaned_1'])
              expect(runIds(once, 'RunInterrupted')).toEqual(['run_orphaned_1'])
              expect(replayRuntimeSessionEvents(once.events)).toEqual([orphanedInput])
              expect(Option.isNone(latestIncompleteRuntimeRun(once.events))).toBe(true)
              expect(yield* store.isClaimed(sessionId)).toBe(true)
              expect(yield* store.resumeCount(sessionId)).toBe(orphanResumeCount)
              expect(yield* driver.isActive(sessionId)).toBe(false)
              expect(yield* Ref.get(drainStarts)).toBe(0)
              expect(yield* Ref.get(requests)).toEqual([])
              const snapshot = yield* hydrateSnapshot(once)
              expect(snapshot.revision).toBe(3)
              expect(snapshot.messages).toEqual([orphanedInput])

              yield* live.reconnect(
                driver,
                sessionId,
                interruptLatestIncompleteRun(sessionId, stores.events)
              )
              const again = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(again).toEqual(once)
              expect(yield* store.isClaimed(sessionId)).toBe(true)
              expect(yield* store.resumeCount(sessionId)).toBe(orphanResumeCount)

              const started = yield* startOwnedAppend({
                live,
                driver,
                eventStorage: stores.events,
                socketId: 'sock_explicit',
                runId: 'run_explicit_1',
                request: { _tag: 'AppendInput', sessionId, input: nextInput },
                config: runtimeConfig,
                runtimeLayer,
                observedEvents,
                lastError
              })

              expect(started._tag).toBe('Accepted')
              expect(yield* Ref.get(lastError)).toBeUndefined()
              const completed = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(completed)).toEqual([
                'InputAppended',
                'RunStarted',
                'RunInterrupted',
                'InputAppended',
                'RunStarted',
                'RunCompleted'
              ])
              expect(completed.revision).toBe(6)
              expect(runIds(completed, 'RunStarted')).toEqual(['run_orphaned_1', 'run_explicit_1'])
              expect(runIds(completed, 'RunInterrupted')).toEqual(['run_orphaned_1'])
              expect(runIds(completed, 'RunCompleted')).toEqual(['run_explicit_1'])
              expect(replayRuntimeSessionEvents(completed.events)).toEqual([
                orphanedInput,
                nextInput,
                explicitAssistant
              ])
              const explicitRequest = (yield* Ref.get(requests))[0]

              if (explicitRequest === undefined) {
                throw new Error('Expected explicit provider request')
              }

              expect(explicitRequest.messages).toEqual([orphanedInput, nextInput])
              expect(yield* store.isClaimed(sessionId)).toBe(false)
              expect(yield* store.resumeCount(sessionId)).toBe(0)
              expect(yield* driver.isActive(sessionId)).toBe(false)
              expect((yield* Ref.get(requests)).length).toBe(1)
              expect(yield* Ref.get(executedTools)).toEqual([])
            })
        )
      })
  )

  it.effect(
    'restores persisted waiting HITL across fresh instances and only resumes a matching response',
    () =>
      Effect.gen(function* () {
        const stores = yield* makeCloningStores()
        const requests = yield* Ref.make<ReadonlyArray<LLMRequest>>([])
        const executedTools = yield* Ref.make<ReadonlyArray<ToolCall>>([])
        const observedEvents = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
        const lastError = yield* Ref.make<unknown>(undefined)

        const scripts = yield* Ref.make<ReadonlyArray<ScriptedTurn>>([
          () => Stream.fromIterable(Reply.toolCall(weatherCall).events),
          () => Stream.fromIterable(Reply.text('sunny').events)
        ])

        const runtimeLayer = makeRuntimeLayer({
          eventStorage: stores.events,
          scripts,
          requests,
          executedTools
        })

        const input = UserMessage.make({ content: 'weather?' })

        yield* Effect.gen(function* () {
          const live = yield* makeLiveDrain()
          const drainStarts = yield* Ref.make(0)
          yield* withFreshHarness(
            {
              live,
              load: stores.harness.load,
              save: stores.harness.save,
              drainStarts
            },
            ({ driver, store }) =>
              Effect.gen(function* () {
                const started = yield* startOwnedAppend({
                  live,
                  driver,
                  eventStorage: stores.events,
                  socketId: 'sock_hitl_a',
                  runId: 'run_hitl_1',
                  request: { _tag: 'AppendInput', sessionId, input },
                  config: weatherConfig,
                  runtimeLayer,
                  observedEvents,
                  lastError
                })

                expect(started._tag).toBe('Accepted')
                const waiting = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
                expect(eventTags(waiting)).toEqual([
                  'InputAppended',
                  'RunStarted',
                  'RunAwaitingInput'
                ])
                expect(runIds(waiting, 'RunStarted')).toEqual(['run_hitl_1'])
                expect(replayRuntimeSessionEvents(waiting.events)).toEqual([
                  input,
                  weatherAssistant
                ])
                expect(Option.isNone(latestIncompleteRuntimeRun(waiting.events))).toBe(true)
                expect(yield* store.isClaimed(sessionId)).toBe(false)
                expect(yield* Ref.get(executedTools)).toEqual([])
              })
          )
        })

        const live = yield* makeLiveDrain()
        const drainStarts = yield* Ref.make(0)
        yield* withFreshHarness(
          {
            live,
            load: stores.harness.load,
            save: stores.harness.save,
            drainStarts
          },
          ({ driver, store }) =>
            Effect.gen(function* () {
              expect((yield* Ref.get(requests)).length).toBe(1)
              expect(yield* store.isClaimed(sessionId)).toBe(false)
              expect(yield* driver.isActive(sessionId)).toBe(false)

              yield* live.reconnect(
                driver,
                sessionId,
                interruptLatestIncompleteRun(sessionId, stores.events)
              )
              const waiting = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(waiting)).toEqual([
                'InputAppended',
                'RunStarted',
                'RunAwaitingInput'
              ])
              expect(waiting.revision).toBe(3)
              expect(Option.isNone(latestIncompleteRuntimeRun(waiting.events))).toBe(true)
              const snapshot = yield* hydrateSnapshot(waiting)
              expect(snapshot.revision).toBe(3)
              expect(snapshot.messages).toEqual([input, weatherAssistant])

              const approval = yield* Schema.decodeUnknownEffect(ToolApprovalRequest)(
                waitingApprovalRequest(waiting)
              )

              const matching = ToolApprovalResponse.make({
                requestId: approval.requestId,
                toolCallId: approval.toolCallId,
                decision: 'approved',
                source: 'user'
              })

              const wrongToolCall = ToolApprovalResponse.make({
                requestId: approval.requestId,
                toolCallId: 'other',
                decision: 'approved',
                source: 'user'
              })

              const wrongRequest = ToolApprovalResponse.make({
                requestId: 'approval:other',
                toolCallId: approval.toolCallId,
                decision: 'approved',
                source: 'user'
              })

              const expectRejectedHitl = (input: {
                readonly socketId: string
                readonly runId: string
                readonly response: ReturnType<typeof ToolApprovalResponse.make>
                readonly expectedRevision: number
              }) =>
                Effect.gen(function* () {
                  const before = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
                  yield* Ref.set(lastError, undefined)

                  const started = yield* startOwnedAppend({
                    live,
                    driver,
                    eventStorage: stores.events,
                    socketId: input.socketId,
                    runId: input.runId,
                    request: {
                      _tag: 'AppendHitlResponse',
                      sessionId,
                      response: input.response,
                      expectedRevision: input.expectedRevision
                    },
                    config: weatherConfig,
                    runtimeLayer,
                    observedEvents,
                    lastError
                  })

                  expect(started._tag).toBe('Accepted')
                  expect(yield* Ref.get(lastError)).toBeInstanceOf(SessionConflictError)
                  const after = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
                  expect(after).toEqual(before)
                  expect(after.revision).toBe(before.revision)
                  expect(yield* Ref.get(executedTools)).toEqual([])
                  expect((yield* Ref.get(requests)).length).toBe(1)
                  expect(yield* store.isClaimed(sessionId)).toBe(false)
                })

              yield* expectRejectedHitl({
                socketId: 'sock_hitl_stale',
                runId: 'run_hitl_stale',
                response: matching,
                expectedRevision: waiting.revision + 1
              })
              yield* expectRejectedHitl({
                socketId: 'sock_hitl_wrong_call',
                runId: 'run_hitl_wrong_call',
                response: wrongToolCall,
                expectedRevision: waiting.revision
              })
              yield* expectRejectedHitl({
                socketId: 'sock_hitl_wrong_request',
                runId: 'run_hitl_wrong_request',
                response: wrongRequest,
                expectedRevision: waiting.revision
              })

              yield* Ref.set(lastError, undefined)

              const resumed = yield* startOwnedAppend({
                live,
                driver,
                eventStorage: stores.events,
                socketId: 'sock_hitl_ok',
                runId: 'run_hitl_2',
                request: {
                  _tag: 'AppendHitlResponse',
                  sessionId,
                  response: matching,
                  expectedRevision: waiting.revision
                },
                config: weatherConfig,
                runtimeLayer,
                observedEvents,
                lastError
              })

              expect(resumed._tag).toBe('Accepted')
              expect(yield* Ref.get(lastError)).toBeUndefined()
              const completed = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
              expect(eventTags(completed)).toEqual([
                'InputAppended',
                'RunStarted',
                'RunAwaitingInput',
                'HitlResponseAppended',
                'RunStarted',
                'RunCompleted'
              ])
              expect(completed.revision).toBe(6)
              expect(runIds(completed, 'RunStarted')).toEqual(['run_hitl_1', 'run_hitl_2'])
              expect(runIds(completed, 'RunCompleted')).toEqual(['run_hitl_2'])
              expect(requireStoredEvent(completed, 'HitlResponseAppended').event).toEqual(
                HitlResponseAppended.make({ response: matching })
              )
              const completedEvent = requireStoredEvent(completed, 'RunCompleted').event

              if (completedEvent._tag !== 'RunCompleted') {
                throw new Error('Expected RunCompleted payload')
              }

              const toolResult = requireToolResult(completedEvent.messages)
              expect(toolResult._tag).toBe('ToolResult')
              expect(toolResult.toolCallId).toBe('call_1')
              expect(toolResult.content).toBe('72F')
              expect(replayRuntimeSessionEvents(completed.events)).toEqual([
                input,
                weatherAssistant,
                toolResult,
                sunnyAssistant
              ])
              expect(yield* Ref.get(executedTools)).toEqual([weatherCall])
              const resumedRequest = (yield* Ref.get(requests))[1]

              if (resumedRequest === undefined) {
                throw new Error('Expected resumed provider request')
              }

              expect(resumedRequest.messages).toEqual([input, weatherAssistant, toolResult])
              expect((yield* Ref.get(requests)).length).toBe(2)
              expect(yield* store.isClaimed(sessionId)).toBe(false)
              expect(yield* driver.isActive(sessionId)).toBe(false)
            })
        )
      })
  )

  it.effect('persists RunFailed for missing Done before and after partial output', () =>
    Effect.gen(function* () {
      const runMissingDone = (input: {
        readonly content: string
        readonly runId: string
        readonly socketId: string
        readonly script: ScriptedTurn
        readonly expectPartial: boolean
      }) =>
        Effect.gen(function* () {
          const stores = yield* makeCloningStores()
          const live = yield* makeLiveDrain()
          const drainStarts = yield* Ref.make(0)
          const requests = yield* Ref.make<ReadonlyArray<LLMRequest>>([])
          const executedTools = yield* Ref.make<ReadonlyArray<ToolCall>>([])
          const observedEvents = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
          const lastError = yield* Ref.make<unknown>(undefined)
          const scripts = yield* Ref.make<ReadonlyArray<ScriptedTurn>>([input.script])

          const runtimeLayer = makeRuntimeLayer({
            eventStorage: stores.events,
            scripts,
            requests,
            executedTools
          })

          const userInput = UserMessage.make({ content: input.content })

          yield* withFreshHarness(
            {
              live,
              load: stores.harness.load,
              save: stores.harness.save,
              drainStarts
            },
            ({ driver, store }) =>
              Effect.gen(function* () {
                const started = yield* startOwnedAppend({
                  live,
                  driver,
                  eventStorage: stores.events,
                  socketId: input.socketId,
                  runId: input.runId,
                  request: { _tag: 'AppendInput', sessionId, input: userInput },
                  config: runtimeConfig,
                  runtimeLayer,
                  observedEvents,
                  lastError
                })

                expect(started._tag).toBe('Accepted')
                const log = yield* loadRuntimeEventLogOrEmpty(sessionId, stores.events)
                expect(eventTags(log)).toEqual(['InputAppended', 'RunStarted', 'RunFailed'])
                expect(log.revision).toBe(3)
                expect(runIds(log, 'RunStarted')).toEqual([input.runId])
                expect(runIds(log, 'RunFailed')).toEqual([input.runId])
                expect(replayRuntimeSessionEvents(log.events)).toEqual([userInput])
                const error = failedError(log)
                expect(error.code).toBe('invalid_response')
                expect(error.message).toContain('Expected exactly one LLM done event, received 0')
                expect(error.retryable).toBe(false)
                const capturedError = yield* Ref.get(lastError)

                if (!(capturedError instanceof LLMError)) {
                  throw new Error(`Expected captured LLMError, got ${String(capturedError)}`)
                }

                expect(capturedError._tag).toBe('LLMError')
                expect(capturedError.cause).toBe('invalid_response')
                expect(capturedError.retryable).toBe(false)
                expect(capturedError.responseIssue).toBe('missing_done')
                expect(capturedError.message).toContain(
                  'Expected exactly one LLM done event, received 0'
                )
                expect(yield* store.isClaimed(sessionId)).toBe(false)
                expect(yield* driver.isActive(sessionId)).toBe(false)
                expect(yield* Ref.get(executedTools)).toEqual([])
                expect((yield* Ref.get(requests)).length).toBe(1)
                expect(
                  (yield* Ref.get(observedEvents)).some(
                    event => event._tag === 'LLMTextDelta' && event.text === 'partial'
                  )
                ).toBe(input.expectPartial)
                expect(
                  (yield* Ref.get(observedEvents)).some(event => event._tag === 'AgentEnd')
                ).toBe(false)
              })
          )
        })

      yield* runMissingDone({
        content: 'missing done before output',
        runId: 'run_missing_before',
        socketId: 'sock_missing_before',
        script: () => Stream.empty,
        expectPartial: false
      })
      yield* runMissingDone({
        content: 'missing done after output',
        runId: 'run_missing_after',
        socketId: 'sock_missing_after',
        script: () => Stream.fromIterable([LLMTextDelta.make({ text: 'partial' })]),
        expectPartial: true
      })
    })
  )
})
