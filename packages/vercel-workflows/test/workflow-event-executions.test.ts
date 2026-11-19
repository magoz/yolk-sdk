import { describe, expect, it } from 'vitest'
import { Effect, Predicate, Schema } from 'effect'
import {
  makeDurableAgentEventSequencerState,
  runVercelAgentWorkflow,
  writeDurableAgentEvent,
  type VercelAgentWorkflowModelStepInput,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowStepRetryPolicy
} from '../src/workflow.ts'
import { TestWorkflowWorld } from '../src/testing/index.ts'

// Every execution of a model step starts from the same `eventSequence`, so
// without an execution id a retried step wrote different events under the first execution's ids
// and a client de-duping by `eventId` showed a splice of both answers ("Hello w cannot").

const streamId = 'workflow:run-1'

const WrittenEvent = Schema.Struct({
  _tag: Schema.String,
  eventId: Schema.String,
  executionId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String)
})

type WrittenEvent = typeof WrittenEvent.Type

const decodeWrittenEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(WrittenEvent))

const textDecoder = new TextDecoder()

const writtenEvents = (chunks: ReadonlyArray<unknown>) =>
  Effect.forEach(chunks, chunk =>
    chunk instanceof Uint8Array
      ? decodeWrittenEvent(textDecoder.decode(chunk).trim())
      : Effect.die(new Error('Expected an NDJSON byte chunk'))
  )

/** Ids that carry two different events: `eventId` de-dupe would drop one of them. */
const aliasedEventIds = (events: ReadonlyArray<WrittenEvent>) => {
  const byId = new Map<string, string>()
  const aliased = new Set<string>()

  for (const event of events) {
    const serialized = JSON.stringify(event)
    const seen = byId.get(event.eventId)

    if (seen !== undefined && seen !== serialized) aliased.add(event.eventId)
    byId.set(event.eventId, serialized)
  }

  return [...aliased]
}

/** What a replay-safe client keeps: the first event per `eventId`. */
const dedupeByEventId = (events: ReadonlyArray<WrittenEvent>) => {
  const seen = new Set<string>()

  return events.filter(event => {
    if (seen.has(event.eventId)) return false
    seen.add(event.eventId)

    return true
  })
}

const textsOf = (events: ReadonlyArray<WrittenEvent>, executionId: string | undefined) =>
  events.flatMap(event =>
    executionId !== undefined &&
    event.executionId === executionId &&
    Predicate.isTagged(event, 'LLMTextDelta')
      ? [event.text]
      : []
  )

const runRetriedModelStep = async (input: {
  readonly modelStepRetry?: VercelAgentWorkflowStepRetryPolicy
  readonly platformMaxRetries: number
}) => {
  const world = new TestWorkflowWorld()

  // Execution 1 streams two deltas and fails (a provider error); execution 2 answers differently.
  const outputs = [
    ['Hel', 'lo w'],
    ['Sorry', ', I', ' cannot']
  ]

  const executionIds: Array<string> = []

  const modelStep = Object.assign(
    async (
      stepInput: VercelAgentWorkflowModelStepInput
    ): Promise<VercelAgentWorkflowModelStepResult> => {
      const { stepId, attempt } = TestWorkflowWorld.getStepMetadata()
      const executionId = `${stepId}:${attempt}`
      const deltas = outputs[executionIds.length] ?? []
      const isLast = executionIds.length === outputs.length - 1
      const turn = stepInput.state.turn
      const writer = TestWorkflowWorld.getWritable<Uint8Array>().getWriter()
      let eventSequence = stepInput.state.eventSequence ?? 0

      executionIds.push(executionId)

      try {
        // Every event the model call produces carries the execution, `LLMStreamStart` included.
        const started = await Effect.runPromise(
          writeDurableAgentEvent({
            writer,
            event: { _tag: 'LLMStreamStart', turn },
            streamId,
            turn,
            executionId,
            state: makeDurableAgentEventSequencerState(eventSequence)
          })
        )

        eventSequence = started.nextEventSequence

        for (const text of deltas) {
          const written = await Effect.runPromise(
            writeDurableAgentEvent({
              writer,
              event: { _tag: 'LLMTextDelta', text },
              streamId,
              turn,
              executionId,
              state: makeDurableAgentEventSequencerState(eventSequence)
            })
          )

          eventSequence = written.nextEventSequence
        }

        if (!isLast) throw new Error('transient provider failure')

        // Committed terminal event: every execution that reaches it writes it identically.
        const end = await Effect.runPromise(
          writeDurableAgentEvent({
            writer,
            event: { _tag: 'AgentEnd' },
            streamId,
            turn,
            state: makeDurableAgentEventSequencerState(eventSequence)
          })
        )

        return {
          done: true,
          messages: [],
          createdMessages: [],
          toolCalls: [],
          usage: {},
          turn,
          eventSequence: end.nextEventSequence
        }
      } finally {
        writer.releaseLock()
      }
    },
    { maxRetries: input.platformMaxRetries }
  )

  const { runId } = world.start(
    () =>
      runVercelAgentWorkflow({
        input: { request: 'request-1', context: 'ctx-1' },
        modelStepRetry: input.modelStepRetry,
        runModelStep: world.step(modelStep, 'model'),
        runToolBatchStep: () => Promise.reject(new Error('unused')),
        closeStream: () => Promise.resolve(),
        writeError: () => Promise.resolve()
      }),
    []
  )

  await world.settled(runId)

  const inspection = world.inspect(runId)

  return {
    status: inspection.status,
    executionIds,
    events: await Effect.runPromise(writtenEvents(inspection.chunks))
  }
}

describe('model-step executions write distinct durable event ids (#305)', () => {
  it.each([
    {
      label: 'a loop retry (modelStepRetry)',
      modelStepRetry: { maxAttempts: 2 },
      platformMaxRetries: 0
    },
    { label: 'a platform retry (fn.maxRetries)', platformMaxRetries: 1 }
  ])('keeps every event of a model step re-run by $label', async config => {
    const { status, executionIds, events } = await runRetriedModelStep(config)

    expect(status).toBe('completed')
    expect(new Set(executionIds).size).toBe(2)
    expect(aliasedEventIds(events)).toEqual([])
    // De-dupe drops nothing, so no execution's output is spliced into another's.
    expect(dedupeByEventId(events)).toEqual(events)
    expect(textsOf(events, executionIds[0])).toEqual(['Hel', 'lo w'])
    expect(textsOf(events, executionIds[1])).toEqual(['Sorry', ', I', ' cannot'])
    // The committed terminal event keeps the deterministic id a replay writes again.
    expect(events.at(-1)).toEqual({ _tag: 'AgentEnd', eventId: `${streamId}:1:4` })
    // Each execution starts with its own `LLMStreamStart`, so clients can tell them apart.
    expect(
      events.flatMap(event =>
        Predicate.isTagged(event, 'LLMStreamStart') ? [event.executionId] : []
      )
    ).toEqual(executionIds)
  })
})
