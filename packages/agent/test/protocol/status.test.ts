import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentBlocked,
  AgentBusy,
  AgentCompacting,
  AgentDone,
  AgentEnd,
  AgentError,
  AgentFailed,
  AgentGenerating,
  AgentRetry,
  AgentRetrying,
  AgentRunningTools,
  AgentStart,
  AgentStatusTree,
  AgentWorking,
  CompactionEnd,
  CompactionStart,
  InputDescriptor,
  InputRequest,
  InteractionDescriptor,
  InteractionRequest,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta,
  QuestionPrompt,
  QuestionRequest,
  SubagentCompleted,
  SubagentStarted,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolCall,
  ToolExecutionAccepted,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolResult,
  TurnEnd,
  TurnStart,
  UsageUpdate,
  agentBlockedKind,
  agentStatusFromEvents,
  agentStatusRetry,
  agentStatusTreeFromEvents,
  hitlRequestBlockedKind,
  idleAgentStatus,
  initialAgentStatusTree,
  makeSubagentRunId,
  nextAgentStatus,
  reconcileAgentStatus,
  settleAgentStatusTree,
  startAgentStatusTree,
  withSubagentStatus,
  zeroAgentUsage,
  type AgentStatus,
  type HitlRequest,
  type SubagentStatusEntry
} from '@yolk-sdk/agent/protocol'

const call = (id: string, name = 'lookup') => ToolCall.make({ id, name, params: {} })

const approval = ToolApprovalRequest.make({
  requestId: 'approval:call_a',
  toolCallId: 'call_a',
  call: call('call_a', 'send_email'),
  policy: ToolApprovalPolicy.make({ mode: 'manual', reason: 'Send?' })
})

const question = QuestionRequest.make({
  requestId: 'question:call_q',
  toolCallId: 'call_q',
  call: call('call_q', 'question'),
  questions: [QuestionPrompt.make({ id: 'customer', prompt: 'Which customer?' })]
})

const input = InputRequest.make({
  requestId: 'input:call_i',
  toolCallId: 'call_i',
  call: call('call_i', 'contact'),
  input: InputDescriptor.make({
    kind: 'custom',
    title: 'Contact',
    schema: { type: 'object', properties: {}, additionalProperties: false }
  })
})

const interaction = InteractionRequest.make({
  requestId: 'interaction:call_x',
  toolCallId: 'call_x',
  call: call('call_x', 'release'),
  interaction: InteractionDescriptor.make({
    kind: 'release-editor',
    actions: [{ id: 'publish', label: 'Publish' }]
  })
})

const awaiting = (requests: readonly [HitlRequest, ...Array<HitlRequest>]) =>
  AgentAwaitingInput.make({ requests, messages: [], turns: 1, usage: zeroAgentUsage })

const end = AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })

const retry = AgentRetry.make({ attempt: 1, reason: 'overloaded', delayMs: 500, message: 'busy' })

const busy = AgentWorking.make({ activity: AgentBusy.make({}) })

const tools = (...ids: ReadonlyArray<string>) =>
  AgentWorking.make({
    activity: AgentRunningTools.make({
      calls: [
        { toolCallId: ids[0] ?? 'missing', name: 'lookup' },
        ...ids.slice(1).map(toolCallId => ({ toolCallId, name: 'lookup' }))
      ]
    })
  })

const result = (toolCallId: string) => ToolResult.make({ toolCallId, content: 'ok' })

const subagentStarted = (callId: string) =>
  SubagentStarted.make({
    parentToolCallId: callId,
    subagentRunId: makeSubagentRunId(callId),
    subagentType: 'research',
    description: 'Look it up',
    model: 'model'
  })

const subagentCompleted = (callId: string, status: 'completed' | 'error', summary?: string) =>
  SubagentCompleted.make({
    parentToolCallId: callId,
    subagentRunId: makeSubagentRunId(callId),
    subagentType: 'research',
    description: 'Look it up',
    model: 'model',
    status,
    durationMs: 10,
    summary
  })

const subagentEntry = (
  callId: string,
  status: AgentStatus,
  background = false
): SubagentStatusEntry => ({
  subagentRunId: makeSubagentRunId(callId),
  parentToolCallId: callId,
  subagentType: 'research',
  description: 'Look it up',
  background,
  status
})

describe('agent status', () => {
  it('maps every HITL request to its OSC 7501 kind', () => {
    expect(hitlRequestBlockedKind(approval)).toBe('permission')
    expect(hitlRequestBlockedKind(interaction)).toBe('permission')
    expect(hitlRequestBlockedKind(question)).toBe('question')
    expect(hitlRequestBlockedKind(input)).toBe('question')
  })

  it('reports permission over question for mixed batches, in any order', () => {
    expect(agentBlockedKind([question, approval])).toBe('permission')
    expect(agentBlockedKind([approval, question])).toBe('permission')
    expect(agentBlockedKind([input, question])).toBe('question')
  })

  it('follows a run from start to done', () => {
    const steps: ReadonlyArray<readonly [Parameters<typeof nextAgentStatus>[1], AgentStatus]> = [
      [AgentStart.make({}), busy],
      [TurnStart.make({ turn: 1 }), busy],
      [LLMStreamStart.make({ turn: 1 }), AgentWorking.make({ activity: AgentGenerating.make({}) })],
      [
        LLMTextDelta.make({ text: 'hi' }),
        AgentWorking.make({ activity: AgentGenerating.make({}) })
      ],
      [LLMStreamEnd.make({ turn: 1 }), busy],
      [ToolExecutionStarted.make({ call: call('a') }), tools('a')],
      [ToolExecutionStarted.make({ call: call('b') }), tools('a', 'b')],
      [ToolExecutionStarted.make({ call: call('b') }), tools('a', 'b')],
      [ToolExecutionCompleted.make({ call: call('a'), result: result('a') }), tools('b')],
      [ToolExecutionError.make({ call: call('b'), message: 'x', code: 'tool_error' }), busy],
      [
        CompactionStart.make({ strategy: 'summary' }),
        AgentWorking.make({ activity: AgentCompacting.make({ strategy: 'summary' }) })
      ],
      [CompactionEnd.make({ strategy: 'summary' }), busy],
      [UsageUpdate.make({ usage: zeroAgentUsage }), busy],
      [TurnEnd.make({ turn: 1, reason: 'stop' }), busy],
      [end, AgentDone.make({})]
    ]

    steps.reduce<AgentStatus>((status, [event, expected]) => {
      const next = nextAgentStatus(status, event)

      expect(next).toEqual(expected)

      return next
    }, idleAgentStatus)
  })

  it('settles accepted background tool calls like completed ones', () => {
    const status = agentStatusFromEvents([
      ToolExecutionStarted.make({ call: call('a') }),
      ToolExecutionAccepted.make({ call: call('a'), result: result('a') })
    ])

    expect(status).toEqual(busy)
  })

  it('tracks a retry until output resumes', () => {
    const retrying = agentStatusFromEvents([AgentStart.make({}), retry])

    expect(retrying).toEqual(AgentWorking.make({ activity: AgentRetrying.make({ retry }) }))
    expect(agentStatusRetry(retrying)).toBe(retry)

    const resumed = nextAgentStatus(retrying, LLMTextDelta.make({ text: 'ok' }))

    expect(resumed).toEqual(AgentWorking.make({ activity: AgentGenerating.make({}) }))
    expect(agentStatusRetry(resumed)).toBeUndefined()
  })

  it('blocks on awaiting input with the requests and their kind', () => {
    const status = agentStatusFromEvents([
      AgentStart.make({}),
      ToolApprovalRequested.make({ call: approval.call, request: approval }),
      awaiting([question, approval])
    ])

    expect(status).toEqual(
      AgentBlocked.make({ kind: 'permission', requests: [question, approval] })
    )
  })

  it('leaves Blocked when a resumed stream shows work without AgentStart', () => {
    const blocked = agentStatusFromEvents([awaiting([approval])])

    expect(nextAgentStatus(blocked, ToolExecutionStarted.make({ call: approval.call }))).toEqual(
      AgentWorking.make({
        activity: AgentRunningTools.make({ calls: [{ toolCallId: 'call_a', name: 'send_email' }] })
      })
    )
  })

  it('treats user cancellation as idle and other aborts as failures', () => {
    const aborted = (abortReason: 'user' | 'system' | 'max_turns') =>
      AgentError.make({
        code: 'aborted',
        message: 'Agent run aborted',
        retryable: abortReason === 'system',
        abortReason
      })

    const legacyAborted = AgentError.make({
      code: 'aborted',
      message: 'Agent run aborted',
      retryable: false
    })

    expect(agentStatusFromEvents([AgentStart.make({}), aborted('user')])).toEqual(idleAgentStatus)
    expect(agentStatusFromEvents([AgentStart.make({}), legacyAborted])).toEqual(idleAgentStatus)

    for (const reason of ['system', 'max_turns'] as const) {
      const error = aborted(reason)

      expect(agentStatusFromEvents([AgentStart.make({}), error])).toEqual(
        AgentFailed.make({ message: 'Agent run aborted', error })
      )
    }
  })

  it('fails with the agent error', () => {
    const error = AgentError.make({ code: 'rate_limit', message: 'slow down', retryable: true })

    expect(agentStatusFromEvents([AgentStart.make({}), error])).toEqual(
      AgentFailed.make({ message: 'slow down', error })
    )
  })

  it('ignores neutral events after a terminal status', () => {
    const done = agentStatusFromEvents([AgentStart.make({}), end])

    expect(nextAgentStatus(done, UsageUpdate.make({ usage: zeroAgentUsage }))).toBe(done)
    expect(nextAgentStatus(done, LLMTextDelta.make({ text: 'late' }))).toBe(done)
    expect(nextAgentStatus(done, LLMStreamEnd.make({ turn: 1 }))).toBe(done)
  })

  it('drops live statuses of runs the host proves are not active', () => {
    const blocked = agentStatusFromEvents([awaiting([question])])
    const failed = AgentFailed.make({ message: 'x' })

    expect(reconcileAgentStatus(busy, { runActive: false })).toEqual(idleAgentStatus)
    expect(reconcileAgentStatus(blocked, { runActive: false })).toEqual(idleAgentStatus)
    expect(reconcileAgentStatus(blocked, { runActive: true })).toBe(blocked)
    expect(reconcileAgentStatus(AgentDone.make({}), { runActive: false })).toEqual(
      AgentDone.make({})
    )
    expect(reconcileAgentStatus(failed, { runActive: false })).toBe(failed)
  })

  it.effect('round-trips statuses through JSON', () =>
    Effect.gen(function* () {
      const codec = Schema.toCodecJson(AgentStatusTree)

      const tree = withSubagentStatus(
        {
          root: agentStatusFromEvents([AgentStart.make({}), retry]),
          subagents: []
        },
        subagentEntry('s', agentStatusFromEvents([awaiting([approval, input])]))
      )

      const encoded = yield* Schema.encodeUnknownEffect(codec)(tree)
      const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(encoded)
      const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(json)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(parsed)

      expect(decoded).toEqual(tree)
    })
  )
})

describe('agent status tree', () => {
  it('tracks inline subagents from start to completion', () => {
    const tree = agentStatusTreeFromEvents([
      AgentStart.make({}),
      ToolExecutionStarted.make({ call: call('s1', 'subagent') }),
      subagentStarted('s1'),
      ToolExecutionStarted.make({ call: call('s2', 'subagent') }),
      subagentStarted('s2'),
      subagentCompleted('s1', 'completed'),
      subagentCompleted('s2', 'error', 'Lookup failed')
    ])

    expect(tree.subagents).toEqual([
      subagentEntry('s1', AgentDone.make({})),
      subagentEntry('s2', AgentFailed.make({ message: 'Lookup failed' }))
    ])
  })

  it('fails a live inline subagent whose call errors', () => {
    const tree = agentStatusTreeFromEvents([
      subagentStarted('s1'),
      ToolExecutionError.make({ call: call('s1', 'subagent'), message: 'boom', code: 'tool_error' })
    ])

    expect(tree.subagents).toEqual([subagentEntry('s1', AgentFailed.make({ message: 'boom' }))])
  })

  it('hands background tool acceptances of subagent calls to the host', () => {
    const tree = agentStatusTreeFromEvents([
      AgentStart.make({}),
      subagentStarted('s1'),
      ToolExecutionAccepted.make({ call: call('s1', 'subagent'), result: result('s1') }),
      end
    ])

    expect(tree.root).toEqual(AgentDone.make({}))
    expect(tree.subagents).toEqual([subagentEntry('s1', busy, true)])

    const blocked = agentStatusFromEvents([awaiting([question])])
    const updated = withSubagentStatus(tree, subagentEntry('s1', blocked, true))

    expect(updated.subagents).toEqual([subagentEntry('s1', blocked, true)])
  })

  it('idles live inline subagents when the run stops', () => {
    const live = agentStatusTreeFromEvents([AgentStart.make({}), subagentStarted('s1')])

    const stopped = agentStatusTreeFromEvents(
      [
        AgentError.make({ code: 'aborted', message: 'stop', retryable: false, abortReason: 'user' })
      ],
      live
    )

    expect(stopped).toEqual({
      root: idleAgentStatus,
      subagents: [subagentEntry('s1', idleAgentStatus)]
    })
    expect(settleAgentStatusTree(live, AgentDone.make({})).subagents).toEqual([
      subagentEntry('s1', idleAgentStatus)
    ])
  })

  it('drops subagents settled in earlier runs when a new run starts', () => {
    const tree = withSubagentStatus(
      withSubagentStatus(initialAgentStatusTree, subagentEntry('old', AgentDone.make({}))),
      subagentEntry('bg', busy, true)
    )

    expect(startAgentStatusTree(tree)).toEqual({
      root: busy,
      subagents: [subagentEntry('bg', busy, true)]
    })
    expect(agentStatusTreeFromEvents([AgentStart.make({})], tree)).toEqual(
      startAgentStatusTree(tree)
    )
  })

  it('keeps the same tree for events that change nothing', () => {
    const tree = agentStatusTreeFromEvents([AgentStart.make({}), subagentStarted('s1')])

    expect(agentStatusTreeFromEvents([UsageUpdate.make({ usage: zeroAgentUsage })], tree)).toBe(
      tree
    )
  })
})
