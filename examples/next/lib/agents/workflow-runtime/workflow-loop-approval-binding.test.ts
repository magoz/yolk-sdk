/**
 * Approval binding through the package Vercel Workflow loop and the agent's `runToolBatch`. The
 * tool step here is a minimal stand-in, not `runAgentWorkflowToolBatchStep` (that needs the
 * Workflow runtime and app layers): it forwards `awaitingRequests` the way the real step does,
 * which the source guard below checks. Two gated siblings pause, the host flips the tool's policy
 * to automatic, one sibling is answered: the other stays pending.
 */
import { readFileSync } from 'node:fs'
import { Effect, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  HitlRequest,
  HitlResponse,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import { LoopConfig, runToolBatch } from '@yolk-sdk/agent/loop'
import { TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  runVercelAgentWorkflow,
  type VercelAgentWorkflowToolBatchStepInput,
  type VercelAgentWorkflowToolBatchStepResult
} from '@yolk-sdk/vercel-workflows'

const gatedTool = ToolDef.make({
  name: 'delete_file',
  description: 'Delete a file.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual' })
})

const autoTool = ToolDef.make({
  name: 'delete_file',
  description: 'Delete a file.',
  parameters: {}
})

const calls = [
  ToolCall.make({ id: 'call_1', name: 'delete_file', params: { path: 'a' } }),
  ToolCall.make({ id: 'call_2', name: 'delete_file', params: { path: 'b' } })
]

const answer = (toolCallId: string, decision: 'approved' | 'denied') =>
  ToolApprovalResponse.make({
    requestId: `approval:${toolCallId}`,
    toolCallId,
    decision,
    source: 'user'
  })

type Round = {
  readonly started: ReadonlyArray<string>
  readonly pending: ReadonlyArray<string>
}

describe('approval binding through the workflow loop (stand-in tool step)', () => {
  it('the real tool step forwards awaitingRequests to prepareToolBatch and runToolBatch', () => {
    const source = readFileSync(
      'examples/next/lib/agents/workflow-runtime/agent-workflow-steps.ts',
      'utf8'
    )

    const prepare = source.slice(source.indexOf('prepareToolBatch({'))
    const run = source.slice(source.indexOf('runToolBatch({'))

    expect(source).toContain('readonly awaitingRequests?: ReadonlyArray<unknown>')
    expect(prepare.slice(0, prepare.indexOf('})'))).toContain('awaitingRequests')
    expect(run.slice(0, run.indexOf('})'))).toContain('awaitingRequests')
  })

  it.effect('keeps an unanswered sibling pending after the policy flips', () =>
    Effect.gen(function* () {
      const rounds: Array<Round> = []
      let gated = true

      const runToolBatchStep = (
        input: VercelAgentWorkflowToolBatchStepInput
      ): Promise<VercelAgentWorkflowToolBatchStepResult> =>
        Effect.runPromise(
          Effect.gen(function* () {
            const batch = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCall))(input.calls)

            const hitlResponses = yield* Schema.decodeUnknownEffect(Schema.Array(HitlResponse))(
              input.hitlResponses ?? []
            )

            const awaitingRequests =
              input.awaitingRequests === undefined
                ? undefined
                : yield* Schema.decodeUnknownEffect(Schema.Array(HitlRequest))(
                    input.awaitingRequests
                  )

            const events: ReadonlyArray<AgentEvent> = Array.from(
              yield* runToolBatch({
                calls: batch,
                tools: [gated ? gatedTool : autoTool],
                hitlResponses,
                awaitingRequests
              }).pipe(
                Stream.runCollect,
                Effect.provide(TestToolExecutor.layer({ delete_file: 'deleted' })),
                Effect.provide(LoopConfig.defaultLayer)
              )
            )

            const awaiting = events.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))

            const requests = Predicate.isTagged(awaiting, 'AgentAwaitingInput')
              ? awaiting.requests
              : []

            rounds.push({
              started: events.flatMap(event =>
                Predicate.isTagged(event, 'ToolExecutionStarted') ? [event.call.id] : []
              ),
              pending: requests.map(request => request.requestId)
            })

            // The host re-reads tool policy before the human answers.
            gated = false

            return requests.length === 0
              ? { messages: ['results'], createdMessages: ['results'] }
              : {
                  messages: [],
                  createdMessages: [],
                  awaitingInput: {
                    hookToken: `hook-${rounds.length}`,
                    requests,
                    messages: [],
                    usage: {},
                    turns: 1
                  }
                }
          })
        )

      const result = yield* Effect.promise(() =>
        runVercelAgentWorkflow({
          input: { request: 'request-1', context: 'ctx-1' },
          runModelStep: modelInput =>
            Promise.resolve({
              done: modelInput.state.turn > 1,
              messages: [],
              createdMessages: [],
              toolCalls: modelInput.state.turn > 1 ? [] : calls,
              usage: {},
              turn: modelInput.state.turn
            }),
          runToolBatchStep,
          // The first answer approves call_1 only; the second denies call_2.
          awaitInput: awaiting =>
            Promise.resolve(
              awaiting.hookToken === 'hook-1'
                ? answer('call_1', 'approved')
                : answer('call_2', 'denied')
            ),
          closeStream: () => Promise.resolve(),
          writeError: () => Promise.resolve()
        })
      )

      expect(result._tag).toBe('Completed')
      expect(rounds).toEqual([
        { started: [], pending: ['approval:call_1', 'approval:call_2'] },
        // call_2 is unanswered and its tool no longer requires approval: still pending.
        { started: [], pending: ['approval:call_2'] },
        { started: ['call_1'], pending: [] }
      ])
    })
  )
})
