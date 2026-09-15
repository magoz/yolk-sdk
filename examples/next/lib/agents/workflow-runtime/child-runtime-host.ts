import { Context, type Effect } from 'effect'
import type { AgentRouteRequest } from '@/lib/agents/route-handler'
import type {
  AgentTextRuntime,
  AgentTextRuntimeOptions,
  makeAgentTextRuntime
} from './text-response'

export type ChildWorkflowIdentityApi = {
  readonly workflowRunId: () => string
}

export type AgentTextRuntimeMake = (
  input: AgentRouteRequest,
  userId: string,
  route: '/agent/next' | '/agent/workflow',
  options?: AgentTextRuntimeOptions
) => Effect.Effect<AgentTextRuntime, Effect.Error<ReturnType<typeof makeAgentTextRuntime>>>

export class ChildWorkflowIdentity extends Context.Service<
  ChildWorkflowIdentity,
  ChildWorkflowIdentityApi
>()('@app/ChildWorkflowIdentity') {}

export class AgentTextRuntimeFactory extends Context.Service<
  AgentTextRuntimeFactory,
  {
    readonly make: AgentTextRuntimeMake
  }
>()('@app/AgentTextRuntimeFactory') {}
