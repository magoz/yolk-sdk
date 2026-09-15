import { Effect, Layer } from 'effect'
import { getWorkflowMetadata } from 'workflow'
import { makeAgentTextRuntime } from './text-response'
import { AgentTextRuntimeFactory, ChildWorkflowIdentity } from './child-runtime-host'

export const ChildWorkflowIdentityLive = Layer.succeed(ChildWorkflowIdentity, {
  workflowRunId: () => getWorkflowMetadata().workflowRunId
})

export const AgentTextRuntimeFactoryLive = Layer.effect(
  AgentTextRuntimeFactory,
  Effect.gen(function* () {
    const services =
      yield* Effect.context<Effect.Services<ReturnType<typeof makeAgentTextRuntime>>>()

    return {
      make: (...args: Parameters<typeof makeAgentTextRuntime>) =>
        makeAgentTextRuntime(...args).pipe(Effect.provideContext(services))
    }
  })
)
