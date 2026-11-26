/**
 * Per-event cost of the chat projection (`@yolk-sdk/agent/chat`) against the length of the chat
 * it folds into: `pnpm bench:chat [--runs N]`.
 *
 * Builds a synthetic history of user questions, tool calls with results and answers
 * (`buildAgentChatMessages`, a run start marked after it, as a host rebuilding a session does),
 * then folds one live durable run into it event by event with `stepAgentChatProjection`: tagged
 * model turns (text and reasoning deltas, a streamed tool call, the `AssistantMessage`), an
 * untagged tool batch, and the terminal `AgentEnd`, with ids as the durable sequencer writes them.
 * Reports the median over `--runs` folds of the microseconds per event (all events, text deltas,
 * the other events), per history length. Flat rows mean the per-event cost does not grow with the
 * chat.
 */
import process from 'node:process'
import { Predicate } from 'effect'
import {
  AgentEnd,
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMReasoningDelta,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta,
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
  type AgentEvent,
  type AgentMessage
} from '../packages/agent/src/protocol/index.ts'
import {
  buildAgentChatMessages,
  makeAgentChatEventProjectionState,
  markChatRunStart,
  stepAgentChatProjection,
  type AgentChatEventProjectionState
} from '../packages/agent/src/chat/index.ts'

const historyLengths = [0, 500, 2_000, 8_000] as const

const liveTurns = 16

const deltasPerTurn = 200

const runsArgument = process.argv.indexOf('--runs')

const runs = runsArgument === -1 ? 5 : Number(process.argv[runsArgument + 1] ?? 5)

const sentence = (seed: number) => `Sentence ${seed} about the session, its stream and its cursor.`

const usage = AgentUsage.make({
  input: AgentInputUsage.make({ total: 1_000 }),
  output: AgentOutputUsage.make({ total: 100 })
})

/** About `rows` chat rows: each exchange is a question, a call with its result, and an answer. */
const history = (rows: number): ReadonlyArray<AgentMessage> =>
  Array.from({ length: Math.ceil(rows / 3) }, (_, exchange) => {
    const call = ToolCall.make({
      id: `history-call-${exchange}`,
      name: 'search',
      params: { query: sentence(exchange) }
    })

    return [
      UserMessage.make({ content: sentence(exchange) }),
      AssistantAgentMessage.make({
        parts: [
          AssistantTextPart.make({ content: sentence(exchange) }),
          HostToolCallPart.make({ call })
        ]
      }),
      ToolResultMessage.make({ toolCallId: call.id, content: sentence(exchange) }),
      AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: sentence(exchange) })]
      })
    ]
  }).flat()

const streamId = 'workflow:bench'

/** One durable run: tagged model turns, an untagged tool batch per turn, and `AgentEnd`. */
const liveRun = (): ReadonlyArray<AgentEvent> => {
  const events: Array<AgentEvent> = []
  let sequence = 0

  const ids = (turn: number, executionId?: string) => {
    const eventId = `${streamId}:${turn}:${sequence}`

    sequence += 1

    return executionId === undefined
      ? { eventId, streamId }
      : { eventId, streamId, executionId, executionTurn: turn }
  }

  const question = UserMessage.make({ content: sentence(-1) })

  events.push(UserMessageEvent.make({ ...ids(1), message: question }))

  for (let turn = 1; turn <= liveTurns; turn += 1) {
    const executionId = `step_model:${turn}:1`
    const tagged = () => ids(turn, executionId)
    const call = ToolCall.make({ id: `live-call-${turn}`, name: 'search', params: { turn } })
    let text = ''

    events.push(LLMStreamStart.make({ ...tagged(), turn }))

    for (let index = 0; index < 20; index += 1) {
      events.push(LLMReasoningDelta.make({ ...tagged(), text: 'thinking ' }))
    }

    for (let index = 0; index < deltasPerTurn; index += 1) {
      const delta = `word${index} `

      text += delta
      events.push(LLMTextDelta.make({ ...tagged(), text: delta }))
    }

    events.push(ToolInputStart.make({ ...tagged(), id: call.id, name: call.name }))

    for (let index = 0; index < 10; index += 1) {
      events.push(ToolInputDelta.make({ ...tagged(), id: call.id, delta: '{' }))
    }

    events.push(ToolInputEnd.make({ ...tagged(), call }))

    const message = AssistantAgentMessage.make({
      parts: [AssistantTextPart.make({ content: text }), HostToolCallPart.make({ call })]
    })

    events.push(AssistantMessageEvent.make({ ...tagged(), message }))
    events.push(LLMStreamEnd.make({ ...tagged(), turn }))
    events.push(TurnEnd.make({ ...tagged(), turn, reason: 'tool_use' }))
    events.push(ToolExecutionStarted.make({ ...ids(turn), call }))

    events.push(
      ToolExecutionCompleted.make({
        ...ids(turn),
        call,
        result: ToolResult.make({ toolCallId: call.id, content: sentence(turn) })
      })
    )
  }

  events.push(AgentEnd.make({ ...ids(liveTurns), messages: [question], turns: liveTurns, usage }))

  return events
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right)

  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const events = liveRun()

const fold = (start: AgentChatEventProjectionState) => {
  let projection = start
  let deltaMs = 0
  let otherMs = 0
  let deltas = 0

  for (const event of events) {
    const started = performance.now()

    projection = stepAgentChatProjection(projection, event, { nowMs: 0 }).projection

    const elapsed = performance.now() - started

    if (
      Predicate.isTagged(event, 'LLMTextDelta') ||
      Predicate.isTagged(event, 'LLMReasoningDelta')
    ) {
      deltaMs += elapsed
      deltas += 1
    } else {
      otherMs += elapsed
    }
  }

  return {
    rows: projection.chatMessages.length,
    all: ((deltaMs + otherMs) * 1_000) / events.length,
    delta: (deltaMs * 1_000) / deltas,
    other: (otherMs * 1_000) / (events.length - deltas)
  }
}

const table = historyLengths.map(rows => {
  const start = markChatRunStart(
    makeAgentChatEventProjectionState(
      buildAgentChatMessages({
        messages: history(rows),
        userDraft: '',
        assistantDraft: '',
        reasoningDraft: '',
        toolRuns: [],
        error: null
      })
    )
  )

  fold(start)

  const results = Array.from({ length: runs }, () => fold(start))

  return {
    'history rows': start.chatMessages.length,
    'µs/event': median(results.map(result => result.all)).toFixed(2),
    'µs/delta': median(results.map(result => result.delta)).toFixed(2),
    'µs/other event': median(results.map(result => result.other)).toFixed(2),
    'rows after': results[0]?.rows ?? 0
  }
})

console.log(`${events.length} events per fold (${liveTurns} turns), median of ${runs} folds`)

console.table(table)
