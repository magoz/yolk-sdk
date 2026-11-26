import { Arbitrary, Match, Option, Predicate, Struct } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentStart,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta,
  QuestionAnswer,
  QuestionAnswered,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
  TurnEnd,
  UserMessage,
  UserMessageEvent,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { agentEventToolCallIds } from '../../src/client/executions.ts'
import { AgentChatAction } from '../../src/chat/chat-actions.ts'
import {
  initialAgentChatState,
  markChatRunStart,
  reduceAgentChatState,
  stepAgentChatProjectionWith,
  type ChatExecutionOutputRecorder
} from '../../src/chat/chat-core.ts'
import { buildAgentChatMessages, turnToolCallMessage } from '../../src/chat/chat-messages.ts'
import {
  AgentChatExecutionOutput,
  type AgentChatMessage,
  type AgentChatState
} from '../../src/chat/chat-schemas.ts'
import { propertyOptions } from './property-options'

// Turn-scoped execution output (`chatExecutionOutput` in `chat-core.ts`) compares only the
// messages after the model turn's start. This folds generated sessions (a long history prefix,
// runs whose turns are superseded, reuse call ids, miss their start, pause and resume, with
// regenerate, edit and delete between runs) twice: through the reducer, and with a reference
// recorder that compares the whole chat from index 0, as the projection did before. The ledgers
// (`executions`: `Message`, `ReplacedMessage`, `ToolPart`, `After`, `Until`) must stay equal.

/**
 * The whole-chat comparison (the recorder before it was turn-scoped), kept as the reference: every
 * message `after` holds that `before` did not is created, and every message of `before` an
 * `AssistantMessage` replaced is recorded with how it was.
 */
const wholeChatExecutionOutput: ChatExecutionOutputRecorder = (
  execution,
  event,
  before,
  after,
  turn
) => {
  const known = new Set(before.map(message => message.id))

  const touched = new Set(
    execution.output.flatMap(output =>
      Predicate.isTagged(output, 'ToolPart') ? [output.callId] : []
    )
  )

  const created = after.flatMap(message =>
    known.has(message.id) ? [] : [AgentChatExecutionOutput.Message({ messageId: message.id })]
  )

  const recorded = new Set(
    execution.output.flatMap(output =>
      Predicate.isTagged(output, 'Message')
        ? [output.messageId]
        : Predicate.isTagged(output, 'ReplacedMessage')
          ? [output.prior.id]
          : []
    )
  )

  const current = new Map(after.map(message => [message.id, message]))

  const replaced = Predicate.isTagged(event, 'AssistantMessage')
    ? before.flatMap(prior => {
        const next = current.get(prior.id)

        return next === undefined || next === prior || recorded.has(prior.id)
          ? []
          : [AgentChatExecutionOutput.ReplacedMessage({ prior })]
      })
    : []

  const parts = agentEventToolCallIds(event).flatMap(callId => {
    if (touched.has(callId)) return []

    const prior = turnToolCallMessage(before, callId, turn)
    const holder = prior ?? turnToolCallMessage(after, callId, turn)

    if (holder === undefined) return []

    const priorPart = Option.fromNullishOr(
      prior?.parts.find(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === callId)
    )

    return [AgentChatExecutionOutput.ToolPart({ callId, messageId: holder.id, prior: priorPart })]
  })

  return [...created, ...replaced, ...parts]
}

/** The reducer's `Event` action with the reference recorder (its projection fields only). */
const referenceReduce = (state: AgentChatState, action: AgentChatAction): AgentChatState => {
  if (!Predicate.isTagged(action, 'Event')) return reduceAgentChatState(state, action)

  const step = stepAgentChatProjectionWith(
    wholeChatExecutionOutput,
    state,
    action.event,
    action.nowMs === undefined ? {} : { nowMs: action.nowMs }
  )

  return { ...Struct.omit(state, ['executions', 'turnStart']), ...step.projection }
}

const between = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const TurnPlan = Schema.Struct({
  /** The call the turn's answer makes; ids come from a small pool, so turns reuse them. */
  call: Schema.Literals(['none', 'call_0', 'call_1']),
  /** Executions of the turn: a later one supersedes the one before. */
  attempts: between(1, 3),
  /** Events a superseded execution streamed before the next one started. */
  cut: between(0, 8),
  /** A superseded execution keeps streaming after it (its events are dropped). */
  late: Schema.Boolean,
  /** The first execution's `LLMStreamStart` is missing (a client rebuilt mid-turn). */
  missedStart: Schema.Boolean,
  /** The model events carry no `executionId` (a host without execution routing). */
  untagged: Schema.Boolean,
  /** The model streams text and tool input before its answer (else only the answer: JSON). */
  stream: Schema.Boolean,
  /**
   * The tool batch: after the answer, before it, before any model output (both out of order, as a
   * redelivery can make them), or none.
   */
  batch: Schema.Literals(['after', 'before', 'first', 'none'])
})

type TurnPlan = typeof TurnPlan.Type

const RunPlan = Schema.TaggedStruct('Run', {
  /** A new `streamId`, or the previous run's (its turns continue). */
  stream: Schema.Literals(['new', 'same']),
  /** How the run opens; `resume` answers the pending question, then `AgentStart`. */
  opening: Schema.Literals(['user', 'agentStart', 'resume', 'none']),
  turns: Schema.Array(TurnPlan).check(Schema.isMaxLength(3)),
  closing: Schema.Literals(['end', 'pause', 'error', 'none']),
  /** The answer each turn's terminal `messages` commit: the first execution's or the last's. */
  committed: Schema.Literals(['first', 'last']),
  /** The run's events are delivered again after it (seen: skipped by `eventId`). */
  replay: Schema.Boolean
})

const EditPlan = Schema.TaggedStruct('Edit', {
  edit: Schema.Literals(['regenerate', 'edit', 'delete']),
  /** Which message, modulo the chat's (user messages for `edit`). */
  pick: between(0, 1_000)
})

const Script = Schema.Struct({
  /** History exchanges before the session (a question, a call with its result, an answer). */
  prefix: between(0, 40),
  steps: Schema.Array(Schema.Union([RunPlan, EditPlan])).check(Schema.isMaxLength(6))
})

type Script = typeof Script.Type

type Planned =
  | { readonly _tag: 'Event'; readonly event: AgentEvent }
  | {
      readonly _tag: 'Edit'
      readonly edit: 'regenerate' | 'edit' | 'delete'
      readonly pick: number
    }

const history = (exchanges: number): ReadonlyArray<AgentMessage> =>
  Array.from({ length: exchanges }, (_, exchange) => {
    // History calls use the live pool's ids: later turns reuse them.
    const call = ToolCall.make({ id: `call_${exchange % 2}`, name: 'search', params: { exchange } })

    return [
      UserMessage.make({ content: `question ${exchange}` }),
      AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'looking' }), HostToolCallPart.make({ call })]
      }),
      ToolResultMessage.make({ toolCallId: call.id, content: 'found' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'answer' })] })
    ]
  }).flat()

const startState = (exchanges: number): AgentChatState =>
  markChatRunStart({
    ...initialAgentChatState,
    chatMessages: buildAgentChatMessages({
      messages: history(exchanges),
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
  })

/** The events and edits a script delivers, in order. */
const plan = (script: Script): ReadonlyArray<Planned> => {
  const planned: Array<Planned> = []
  let sequence = 0
  let streams = 0
  let streamId = 'stream-0'
  let turn = 0
  let pending: QuestionRequest | undefined

  const eventId = () => {
    sequence += 1

    return `event-${sequence}`
  }

  const push = (event: AgentEvent) => planned.push({ _tag: 'Event', event })

  for (const step of script.steps) {
    if (Predicate.isTagged(step, 'Edit')) {
      planned.push({ _tag: 'Edit', edit: step.edit, pick: step.pick })

      continue
    }

    const runStart = planned.length

    if (step.stream === 'new') {
      streams += 1
      streamId = `stream-${streams}`
      turn = 0
    }

    const host = () => ({ eventId: eventId(), streamId })

    Match.value(step.opening).pipe(
      Match.when('user', () =>
        push(
          UserMessageEvent.make({
            ...host(),
            message: UserMessage.make({ content: `ask ${sequence}` })
          })
        )
      ),
      Match.when('agentStart', () => push(AgentStart.make(host()))),
      Match.when('resume', () => {
        push(AgentStart.make(host()))

        if (pending !== undefined) {
          push(
            QuestionAnswered.make({
              ...host(),
              response: QuestionResponse.make({
                requestId: pending.requestId,
                toolCallId: pending.toolCallId,
                outcome: 'answered',
                source: 'user',
                answers: [QuestionAnswer.make({ questionId: 'choice', customAnswer: 'yes' })]
              })
            })
          )
        }
      }),
      Match.when('none', () => undefined),
      Match.exhaustive
    )

    pending = undefined

    const answers: Array<{
      readonly first: AssistantAgentMessage
      readonly last: AssistantAgentMessage
    }> = []

    let lastCall: ToolCall | undefined

    for (const turnPlan of step.turns) {
      turn += 1

      const result = modelTurn(turnPlan, streamId, turn, eventId)

      for (const event of result.events) push(event)

      answers.push({ first: result.answers[0], last: result.answers.at(-1) ?? result.answers[0] })
      lastCall = result.call
    }

    const committed = answers.map(answer =>
      step.committed === 'first' ? answer.first : answer.last
    )

    Match.value(step.closing).pipe(
      Match.when('end', () =>
        push(AgentEnd.make({ ...host(), messages: committed, turns: turn, usage: zeroAgentUsage }))
      ),
      Match.when('pause', () => {
        if (lastCall === undefined) {
          push(
            AgentEnd.make({ ...host(), messages: committed, turns: turn, usage: zeroAgentUsage })
          )

          return
        }

        const request = QuestionRequest.make({
          requestId: `question:${lastCall.id}:${sequence}`,
          toolCallId: lastCall.id,
          call: lastCall,
          questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Go on?' })]
        })

        push(QuestionRequested.make({ ...host(), request }))

        push(
          AgentAwaitingInput.make({
            ...host(),
            requests: [request],
            messages: committed,
            turns: turn,
            usage: zeroAgentUsage
          })
        )

        pending = request
      }),
      Match.when('error', () =>
        push(
          AgentError.make({ ...host(), code: 'provider_error', message: 'boom', retryable: true })
        )
      ),
      Match.when('none', () => undefined),
      Match.exhaustive
    )

    if (step.replay) planned.push(...planned.slice(runStart))
  }

  return planned
}

/** One model turn: its executions' events (superseded ones cut short), then its tool batch. */
const modelTurn = (turnPlan: TurnPlan, streamId: string, turn: number, eventId: () => string) => {
  const call =
    turnPlan.call === 'none'
      ? undefined
      : ToolCall.make({ id: turnPlan.call, name: 'search', params: { streamId, turn } })

  const executionEvents = (attempt: number) => {
    const executionId = `${streamId}:${turn}:${attempt}`

    const ids = () =>
      turnPlan.untagged
        ? { eventId: eventId(), streamId }
        : { eventId: eventId(), streamId, executionId, executionTurn: turn }

    const answer = AssistantAgentMessage.make({
      parts: [
        AssistantTextPart.make({ content: `answer ${turn}.${attempt}` }),
        ...(call === undefined ? [] : [HostToolCallPart.make({ call })])
      ]
    })

    const started =
      attempt === 1 && turnPlan.missedStart ? [] : [LLMStreamStart.make({ ...ids(), turn })]

    const streamed: ReadonlyArray<AgentEvent> = !turnPlan.stream
      ? []
      : [
          LLMTextDelta.make({ ...ids(), text: `answer ${turn}.` }),
          LLMTextDelta.make({ ...ids(), text: `${attempt}` }),
          ...(call === undefined
            ? []
            : [
                ToolInputStart.make({ ...ids(), id: call.id, name: call.name }),
                ToolInputDelta.make({ ...ids(), id: call.id, delta: '{}' }),
                ToolInputEnd.make({ ...ids(), call })
              ])
        ]

    const events: ReadonlyArray<AgentEvent> = [
      ...started,
      ...streamed,
      AssistantMessageEvent.make({ ...ids(), message: answer }),
      LLMStreamEnd.make({ ...ids(), turn }),
      TurnEnd.make({ ...ids(), turn, reason: call === undefined ? 'stop' : 'tool_use' })
    ]

    return { events, answer }
  }

  const executions = Array.from({ length: turnPlan.attempts }, (_, index) =>
    executionEvents(index + 1)
  )

  // A superseded execution streams `cut` events before the next one starts; the rest come late
  // (after the turn's last execution) or never.
  const model = executions.flatMap((execution, index) =>
    index === executions.length - 1 ? execution.events : execution.events.slice(0, turnPlan.cut)
  )

  const late = turnPlan.late
    ? executions.slice(0, -1).flatMap(execution => execution.events.slice(turnPlan.cut))
    : []

  const batch =
    call === undefined
      ? []
      : [
          ToolExecutionStarted.make({ eventId: eventId(), streamId, call }),
          ToolExecutionCompleted.make({
            eventId: eventId(),
            streamId,
            call,
            result: ToolResult.make({ toolCallId: call.id, content: `result ${turn}` })
          })
        ]

  // A batch before the answer arrives after the turn's tool input; one first, after the turn's
  // first start (or at once, when it was missed).
  const at = Match.value(turnPlan.batch).pipe(
    Match.when('before', () =>
      model.findIndex(event => Predicate.isTagged(event, 'AssistantMessage'))
    ),
    Match.when('first', () => (Predicate.isTagged(model[0], 'LLMStreamStart') ? 1 : 0)),
    Match.orElse(() => -1)
  )

  const events =
    turnPlan.batch === 'none'
      ? [...model, ...late]
      : at === -1
        ? [...model, ...late, ...batch]
        : [...model.slice(0, at), ...batch, ...model.slice(at), ...late]

  return { events, call, answers: executions.map(execution => execution.answer) }
}

/** The edit action a planned edit names in the chat, if the chat has such a message. */
const editAction = (
  messages: ReadonlyArray<AgentChatMessage>,
  edit: 'regenerate' | 'edit' | 'delete',
  pick: number
): AgentChatAction | undefined => {
  const candidates =
    edit === 'edit' ? messages.filter(message => message.role === 'user') : messages

  const target = candidates[pick % Math.max(candidates.length, 1)]

  if (target === undefined) return undefined

  return Match.value(edit).pipe(
    Match.when('regenerate', () => AgentChatAction.RegenerateFrom({ messageId: target.id })),
    Match.when('edit', () =>
      AgentChatAction.EditUserMessage({ messageId: target.id, content: `edited ${pick}` })
    ),
    Match.when('delete', () => AgentChatAction.DeleteTurn({ messageId: target.id })),
    Match.exhaustive
  )
}

type Folded = {
  readonly production: AgentChatState
  readonly reference: AgentChatState
  /** Output tags the production ledger recorded at some step. */
  readonly tags: ReadonlySet<string>
}

const outputTags = (state: AgentChatState) =>
  (state.executions ?? []).flatMap(run =>
    run.executions.flatMap(execution => execution.output.map(output => output._tag))
  )

/** Folds a script both ways, checking the ledgers agree after every step. */
const foldBoth = (script: Script): Folded => {
  const start = startState(script.prefix)
  let production = start
  let reference = start
  const tags = new Set<string>()

  for (const planned of plan(script)) {
    const action = Predicate.isTagged(planned, 'Event')
      ? AgentChatAction.Event({ event: planned.event, nowMs: 1 })
      : editAction(production.chatMessages, planned.edit, planned.pick)

    if (action === undefined) continue

    production = reduceAgentChatState(production, action)
    reference = referenceReduce(reference, action)

    expect(production.executions).toEqual(reference.executions)
    expect(production.chatMessages).toEqual(reference.chatMessages)
    expect(production.turnStart).toEqual(reference.turnStart)

    // Released runs (ended or retired) hold no output and no calls: per-event work skips them.
    for (const run of production.executions ?? []) {
      if (run.ended || run.retired) {
        for (const execution of run.executions) {
          expect(execution.output).toEqual([])
          expect(execution.calls).toEqual([])
          expect(execution.status).not.toBe('Live')
        }
      }
    }

    for (const tag of outputTags(production)) tags.add(tag)
  }

  return { production, reference, tags }
}

const turn = (overrides: Partial<TurnPlan> = {}): TurnPlan => ({
  call: 'call_0',
  attempts: 1,
  cut: 0,
  late: false,
  missedStart: false,
  untagged: false,
  stream: true,
  batch: 'after',
  ...overrides
})

describe('turn-scoped execution output', () => {
  it.prop(
    'records what the whole-chat comparison records',
    [Arbitrary.schema(Script)],
    ([script]) => {
      foldBoth(script)
    },
    propertyOptions
  )

  it('agrees on a fixed session that records every output kind', () => {
    const { tags, production } = foldBoth({
      prefix: 30,
      steps: [
        {
          _tag: 'Run',
          stream: 'new',
          opening: 'user',
          turns: [
            turn({ attempts: 2, cut: 6, late: true }),
            turn({ call: 'call_1', attempts: 3, cut: 3, batch: 'before' })
          ],
          closing: 'pause',
          committed: 'first',
          replay: false
        },
        {
          _tag: 'Run',
          stream: 'same',
          opening: 'resume',
          turns: [turn({ missedStart: true, attempts: 2, cut: 4 }), turn({ call: 'none' })],
          closing: 'end',
          committed: 'last',
          replay: true
        },
        { _tag: 'Edit', edit: 'delete', pick: 7 },
        {
          _tag: 'Run',
          stream: 'new',
          opening: 'user',
          turns: [
            turn({ batch: 'before', attempts: 2, cut: 8 }),
            turn({ untagged: true }),
            turn({ call: 'call_1', stream: false, batch: 'first' })
          ],
          closing: 'none',
          committed: 'last',
          replay: false
        },
        { _tag: 'Edit', edit: 'regenerate', pick: 11 },
        {
          _tag: 'Run',
          stream: 'same',
          opening: 'agentStart',
          turns: [turn({ missedStart: true, batch: 'before' })],
          closing: 'error',
          committed: 'last',
          replay: false
        },
        { _tag: 'Edit', edit: 'edit', pick: 3 },
        {
          _tag: 'Run',
          stream: 'new',
          opening: 'user',
          turns: [turn({ attempts: 2, cut: 5, late: true, batch: 'before' })],
          closing: 'end',
          committed: 'first',
          replay: false
        }
      ]
    })

    expect([...tags].sort()).toEqual(['After', 'Message', 'ReplacedMessage', 'ToolPart', 'Until'])
    expect(production.chatMessages.length).toBeGreaterThan(0)
  })
})
