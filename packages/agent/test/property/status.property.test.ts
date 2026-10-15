import { Arbitrary, Match, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentRetry,
  AgentStart,
  CompactionEnd,
  CompactionStart,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta,
  SubagentCompleted,
  SubagentStarted,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolResult,
  TurnStart,
  UsageUpdate,
  agentStatusTreeFromEvents,
  idleAgentStatus,
  isAgentStatusLive,
  makeSubagentRunId,
  nextAgentStatus,
  zeroAgentUsage,
  type AgentEvent,
  type AgentStatus
} from '@yolk-sdk/agent/protocol'
import { propertyOptions } from './property-options'

const EventKind = Schema.Literals([
  'start',
  'turn',
  'stream_start',
  'stream_end',
  'delta',
  'tool_start',
  'tool_end',
  'compaction_start',
  'compaction_end',
  'retry',
  'usage',
  'subagent_start',
  'subagent_end',
  'awaiting',
  'end',
  'error',
  'cancel'
])

type EventKind = typeof EventKind.Type

const EventCase = Schema.Struct({
  kind: EventKind,
  slot: Schema.Literals(['a', 'b', 'c'])
})

const eventsArbitrary = Arbitrary.schema(Schema.Array(EventCase))

const terminalKinds: ReadonlySet<EventKind> = new Set(['awaiting', 'end', 'error', 'cancel'])

const workKinds: ReadonlySet<EventKind> = new Set([
  'start',
  'turn',
  'stream_start',
  'tool_start',
  'compaction_start',
  'retry'
])

const call = (slot: string) => ToolCall.make({ id: `call_${slot}`, name: 'lookup', params: {} })

const approval = ToolApprovalRequest.make({
  requestId: 'approval:call_a',
  toolCallId: 'call_a',
  call: call('a'),
  policy: ToolApprovalPolicy.make({ mode: 'manual', reason: 'Approve?' })
})

const subagentFields = (slot: string) => ({
  parentToolCallId: `call_${slot}`,
  subagentRunId: makeSubagentRunId(`call_${slot}`),
  subagentType: 'research',
  description: 'Look it up',
  model: 'model'
})

const toEvent = ({ kind, slot }: typeof EventCase.Type): AgentEvent =>
  Match.value(kind).pipe(
    Match.withReturnType<AgentEvent>(),
    Match.when('start', () => AgentStart.make({})),
    Match.when('turn', () => TurnStart.make({ turn: 1 })),
    Match.when('stream_start', () => LLMStreamStart.make({ turn: 1 })),
    Match.when('stream_end', () => LLMStreamEnd.make({ turn: 1 })),
    Match.when('delta', () => LLMTextDelta.make({ text: 'x' })),
    Match.when('tool_start', () => ToolExecutionStarted.make({ call: call(slot) })),
    Match.when('tool_end', () =>
      ToolExecutionCompleted.make({
        call: call(slot),
        result: ToolResult.make({ toolCallId: `call_${slot}`, content: 'ok' })
      })
    ),
    Match.when('compaction_start', () => CompactionStart.make({ strategy: 'summary' })),
    Match.when('compaction_end', () => CompactionEnd.make({ strategy: 'summary' })),
    Match.when('retry', () =>
      AgentRetry.make({ attempt: 1, reason: 'overloaded', delayMs: 1, message: 'busy' })
    ),
    Match.when('usage', () => UsageUpdate.make({ usage: zeroAgentUsage })),
    Match.when('subagent_start', () => SubagentStarted.make(subagentFields(slot))),
    Match.when('subagent_end', () =>
      SubagentCompleted.make({ ...subagentFields(slot), status: 'completed', durationMs: 1 })
    ),
    Match.when('awaiting', () =>
      AgentAwaitingInput.make({
        requests: [approval],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })
    ),
    Match.when('end', () => AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })),
    Match.when('error', () =>
      AgentError.make({ code: 'provider_error', message: 'failed', retryable: false })
    ),
    Match.when('cancel', () =>
      AgentError.make({ code: 'aborted', message: 'stop', retryable: false, abortReason: 'user' })
    ),
    Match.exhaustive
  )

const terminalTag = (kind: EventKind): AgentStatus['_tag'] | undefined =>
  Match.value(kind).pipe(
    Match.withReturnType<AgentStatus['_tag'] | undefined>(),
    Match.when('awaiting', () => 'Blocked'),
    Match.when('end', () => 'Done'),
    Match.when('error', () => 'Failed'),
    Match.when('cancel', () => 'Idle'),
    Match.orElse(() => undefined)
  )

describe('agent status property tests', () => {
  it.prop(
    'a terminal status holds until the next work event',
    [eventsArbitrary],
    ([cases]) => {
      const lastTerminal = cases.findLastIndex(current => terminalKinds.has(current.kind))
      const tree = agentStatusTreeFromEvents(cases.map(toEvent))

      if (lastTerminal === -1) {
        expect(['Idle', 'Working']).toContain(tree.root._tag)

        return
      }

      const after = cases.slice(lastTerminal + 1)

      if (after.some(current => workKinds.has(current.kind))) {
        expect(tree.root._tag).toBe('Working')
      } else {
        expect(tree.root._tag).toBe(terminalTag(cases[lastTerminal]?.kind ?? 'end'))
      }
    },
    propertyOptions
  )

  it.prop(
    'inline subagents never stay live after the run stops',
    [eventsArbitrary],
    ([cases]) => {
      const tree = agentStatusTreeFromEvents(cases.map(toEvent))
      const last = cases.at(-1)?.kind

      if (last === 'end' || last === 'error' || last === 'cancel') {
        expect(tree.subagents.filter(entry => isAgentStatusLive(entry.status))).toEqual([])
      }

      expect(new Set(tree.subagents.map(entry => entry.subagentRunId)).size).toBe(
        tree.subagents.length
      )
    },
    propertyOptions
  )

  it.prop(
    'neutral events never change a settled status',
    [eventsArbitrary],
    ([cases]) => {
      const neutral = cases.filter(
        current => !workKinds.has(current.kind) && !terminalKinds.has(current.kind)
      )

      const done = nextAgentStatus(
        idleAgentStatus,
        AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })
      )

      expect(neutral.map(toEvent).reduce(nextAgentStatus, done)).toBe(done)
    },
    propertyOptions
  )
})
