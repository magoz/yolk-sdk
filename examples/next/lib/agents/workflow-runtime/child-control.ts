import { getWorkflowMetadata } from 'workflow'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { readWorkflowChild, type WorkflowChildRead } from '@/lib/services/agent-workflow/read-child'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolExecutor, ToolError } from '@yolk-sdk/agent/loop'
import {
  AgentEnd,
  AgentMessage,
  AgentUsage,
  ToolCall,
  ToolResult,
  UserMessage,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  makeSubagentAcceptedToolResult,
  makeSubagentToolResult,
  subagentResultFromEvents,
  subagentToolRunId,
  type SubagentToolParams,
  type ToolModule
} from '@yolk-sdk/agent/tools'
import type { SerializableWorkflowState } from '@yolk-sdk/vercel-workflows'
import { AppLayer } from '@/lib/layers'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import type { AgentToolContext } from '@/lib/agents/tools/tool-context'
import { AgentWorkflowStore } from '@/lib/services/agent-workflow/live-layer'
import { WorkflowChildRecord, WorkflowRegistryError } from '@/lib/services/agent-workflow/registry'
import { makeAgentTextRuntime } from './text-response'

export class WorkflowAgentContext extends Schema.Class<WorkflowAgentContext>(
  'WorkflowAgentContext'
)({
  userId: Schema.String,
  parentRunId: Schema.optionalKey(Schema.String),
  callId: Schema.optionalKey(Schema.String),
  childType: Schema.optionalKey(Schema.String)
}) {}

const LookupParams = Schema.Struct({
  tool_call_id: Schema.String,
  parent_run_id: Schema.optionalKey(
    Schema.String.pipe(
      Schema.annotate({
        description:
          'Original parent run from the accepted handle. Required when reading a child launched in an earlier conversation run.'
      })
    )
  )
})
const lookupModules: ReadonlyArray<ToolModule<AgentToolContext>> = [
  {
    id: 'workflow-subagent-control',
    tools: ['subagent_status', 'subagent_wait'].map(name =>
      makeTool({
        name,
        description:
          name === 'subagent_status'
            ? 'Read a previously launched child by its original tool call id.'
            : 'Durably wait for a previously launched child by its original tool call id.',
        parameters: LookupParams,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(
            ToolResult.make({
              toolCallId: call.id,
              content: 'Workflow orchestration required',
              isError: true
            })
          )
      })
    )
  }
]

const unavailableSubagent = ({ call }: { readonly call: ToolCall }) =>
  Effect.fail(
    new ToolError({
      tool: call.name,
      cause: 'execution',
      message: 'Workflow orchestration required'
    })
  )

export const workflowRuntime = (request: AgentRouteRequest, context: WorkflowAgentContext) =>
  makeAgentTextRuntime(request, context.userId, '/agent/workflow', {
    ...(context.childType === undefined
      ? { executeSubagent: unavailableSubagent, modules: lookupModules }
      : { childType: context.childType })
  })

export const assertChildAdmission = (context: WorkflowAgentContext, physicalRunId: string) =>
  Effect.gen(function* () {
    const store = yield* AgentWorkflowStore
    if (context.parentRunId === undefined || context.callId === undefined) {
      const registry = yield* store.read(physicalRunId, context.userId)
      if (registry.stopped)
        return yield* Effect.fail(
          new WorkflowRegistryError({ message: 'Parent execution is stopped' })
        )
      return
    }
    const registry = yield* store.read(context.parentRunId, context.userId)
    if (
      registry.stopped ||
      !registry.children.some(
        child => child.callId === context.callId && child.workflowRunId === physicalRunId
      )
    ) {
      return yield* Effect.fail(new WorkflowRegistryError({ message: 'Child execution is fenced' }))
    }
  })

const runStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(AgentWorkflowStore.layer))

export async function registerWorkflowStep(userId: string) {
  const runId = getWorkflowMetadata().workflowRunId
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AgentWorkflowStore
      yield* store.register(runId, userId)
    }).pipe(runStore)
  )
}

export type ChildLaunch = {
  readonly parentRunId: string
  readonly userId: string
  readonly callId: string
}

export type WorkflowCallPlan =
  | { readonly type: 'normal' }
  | { readonly type: 'result'; readonly result: unknown }
  | { readonly type: 'lookup'; readonly child: ChildLaunch; readonly wait: boolean }
  | {
      readonly type: 'launch'
      readonly child: ChildLaunch
      readonly background: boolean
      readonly model: string
      readonly workflowRunId: string | null
    }

const failureResult = (callId: string, message: string) =>
  ToolResult.make({ toolCallId: callId, content: message, isError: true })

export async function planWorkflowCallStep(input: {
  readonly context: unknown
  readonly request: unknown
  readonly call: unknown
}): Promise<WorkflowCallPlan> {
  const parentRunId = getWorkflowMetadata().workflowRunId
  return await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Schema.decodeUnknownEffect(WorkflowAgentContext)(input.context)
      const call = yield* Schema.decodeUnknownEffect(ToolCall)(input.call)
      if (call.name === 'subagent_status' || call.name === 'subagent_wait') {
        const params = yield* Schema.decodeUnknownEffect(LookupParams)(call.params).pipe(
          Effect.result
        )
        if (params._tag === 'Failure')
          return {
            type: 'result',
            result: yield* Schema.encodeEffect(ToolResult)(
              failureResult(call.id, 'Invalid child handle')
            )
          } as const
        return {
          type: 'lookup',
          child: {
            parentRunId: params.success.parent_run_id ?? parentRunId,
            userId: context.userId,
            callId: params.success.tool_call_id
          },
          wait: call.name === 'subagent_wait'
        } as const
      }
      if (call.name !== 'subagent') return { type: 'normal' } as const
      return yield* Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(input.request)
        let params: SubagentToolParams | undefined
        const runtime = yield* makeAgentTextRuntime(request, context.userId, '/agent/workflow', {
          executeSubagent: input =>
            Effect.sync(() => {
              params = input.params
              return ToolResult.make({ toolCallId: input.call.id, content: '' })
            })
        })
        const validated = yield* Effect.gen(function* () {
          const executor = yield* ToolExecutor
          return yield* executor.execute(call)
        }).pipe(
          Effect.provide(runtime.layer),
          Effect.catchTag('ToolError', error =>
            Effect.succeed(failureResult(call.id, error.message))
          )
        )
        if (params === undefined)
          return {
            type: 'result',
            result: yield* Schema.encodeEffect(ToolResult)(validated)
          } as const
        const childRequest = AgentRouteRequest.make({
          sessionId: `${request.sessionId}:subagent:${call.id}`,
          messages: [UserMessage.make({ content: params.prompt })],
          model: params.model ?? runtime.config.model,
          reasoningEffort:
            params.reasoning_effort ?? request.reasoningEffort ?? runtime.config.reasoningEffort
        })
        const store = yield* AgentWorkflowStore
        const registry = yield* store.change(parentRunId, context.userId, {
          type: 'reserve',
          child: WorkflowChildRecord.make({
            callId: call.id,
            request: yield* Schema.encodeEffect(AgentRouteRequest)(childRequest),
            subagentType: params.subagent_type,
            description: params.description,
            startedAtMs: Date.now(),
            workflowRunId: null,
            result: null
          })
        })
        const child = registry.children.find(child => child.callId === call.id)
        if (registry.stopped || child === undefined)
          return {
            type: 'result',
            result: yield* Schema.encodeEffect(ToolResult)(
              failureResult(call.id, 'Child launch stopped or run child limit reached')
            )
          } as const
        const reservedRequest = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(child.request)
        return {
          type: 'launch',
          child: { parentRunId, userId: context.userId, callId: call.id },
          background: params.background === true,
          model: reservedRequest.model ?? runtime.config.model,
          workflowRunId: child.workflowRunId
        } as const
      }).pipe(
        Effect.catch(() =>
          Schema.encodeEffect(ToolResult)(
            failureResult(call.id, 'Child launch preparation failed')
          ).pipe(Effect.map(result => ({ type: 'result' as const, result })))
        )
      )
    }).pipe(runStore, Effect.provide(AppLayer), Effect.scoped)
  )
}

export async function admitChildWorkflowStep(input: ChildLaunch) {
  const workflowRunId = getWorkflowMetadata().workflowRunId
  return await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AgentWorkflowStore
      const registry = yield* store.change(input.parentRunId, input.userId, {
        type: 'admit',
        callId: input.callId,
        workflowRunId
      })
      const child = registry.children.find(child => child.callId === input.callId)
      if (registry.stopped || child === undefined || child.workflowRunId !== workflowRunId)
        return null
      return {
        request: child.request,
        context: {
          userId: input.userId,
          parentRunId: input.parentRunId,
          callId: input.callId,
          childType: child.subagentType
        }
      }
    }).pipe(runStore)
  )
}

export async function persistChildTerminalStep(
  input: ChildLaunch,
  terminal: { readonly status: 'completed' | 'error'; readonly state: SerializableWorkflowState }
) {
  const workflowRunId = getWorkflowMetadata().workflowRunId
  return await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AgentWorkflowStore
      const registry = yield* store.read(input.parentRunId, input.userId)
      const child = registry.children.find(child => child.callId === input.callId)
      if (child === undefined)
        return yield* Effect.fail(
          new WorkflowRegistryError({ message: 'Child reservation missing' })
        )
      const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(child.request)
      const messages = yield* Schema.decodeUnknownEffect(Schema.Array(AgentMessage))(
        terminal.state.createdMessages
      )
      const usage =
        terminal.state.usage === undefined
          ? zeroAgentUsage
          : yield* Schema.decodeUnknownEffect(AgentUsage)(terminal.state.usage)
      const summary = subagentResultFromEvents([
        AgentEnd.make({ messages, usage, turns: terminal.state.turn })
      ])
      const result = makeSubagentToolResult({
        callId: child.callId,
        subagentRunId: subagentToolRunId(child.callId),
        subagentType: child.subagentType,
        description: child.description,
        startedAtMs: child.startedAtMs,
        endedAtMs: Date.now(),
        model: request.model ?? '',
        reasoningEffort: request.reasoningEffort,
        status: terminal.status,
        output: terminal.status === 'completed' ? summary.text : 'Child workflow failed',
        usage,
        turns: terminal.state.turn
      })
      const encoded = yield* Schema.encodeEffect(ToolResult)(result)
      yield* store.change(input.parentRunId, input.userId, {
        type: 'complete',
        callId: input.callId,
        workflowRunId,
        result: encoded
      })
      return { status: terminal.status, result: encoded }
    }).pipe(runStore)
  )
}

export type ChildRead = WorkflowChildRead

export async function readChildWorkflowStep(
  input: ChildLaunch,
  attemptedRunId?: string
): Promise<ChildRead> {
  return await Effect.runPromise(
    readWorkflowChild(input, attemptedRunId).pipe(runStore, Effect.provide(VercelWorkflows.layer))
  )
}

export async function attachChildWorkflowStep(input: ChildLaunch, workflowRunId: string) {
  // Response-path repair: if the child already self-admitted this is a no-op. A lost
  // start response is also safe because the child's own admission does not depend on it.
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AgentWorkflowStore
      yield* store.change(input.parentRunId, input.userId, {
        type: 'admit',
        callId: input.callId,
        workflowRunId
      })
    }).pipe(runStore)
  )
}

export async function childToolResultStep(input: {
  readonly callId: string
  readonly child: ChildRead
  readonly lookup: boolean
  readonly background?: boolean
  readonly parentRunId?: string
}) {
  return await Effect.runPromise(
    Effect.gen(function* () {
      if (!input.lookup && input.background === true && input.child.workflowRunId !== null)
        return yield* Schema.encodeEffect(ToolResult)(
          makeSubagentAcceptedToolResult({
            callId: input.callId,
            workflowRunId: input.child.workflowRunId,
            ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId })
          })
        )
      if (!input.lookup && input.child.done) return input.child.result
      // Lookup results deliberately nest the original result. They are observations, not new usage deltas.
      const terminal = input.child.done
        ? yield* Schema.decodeUnknownEffect(ToolResult)(input.child.result)
        : undefined
      return yield* Schema.encodeEffect(ToolResult)(
        ToolResult.make({
          toolCallId: input.callId,
          content: terminal?.content ?? 'Child is running',
          isError: terminal?.isError,
          structuredContent: {
            type: 'subagent_observation',
            done: input.child.done,
            workflow_run_id: input.child.workflowRunId,
            result: input.child.result
          }
        })
      )
    })
  )
}

export async function uncertainChildLaunchStep(input: ChildLaunch) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AgentWorkflowStore
      yield* store.change(input.parentRunId, input.userId, {
        type: 'launch-uncertain',
        callId: input.callId
      })
    }).pipe(runStore)
  )
}

export async function childControlFailureStep(callId: string) {
  return await Effect.runPromise(
    Schema.encodeEffect(ToolResult)(
      failureResult(callId, 'Child control failed; use subagent_status to inspect the reservation')
    )
  )
}
