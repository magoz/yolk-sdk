import { Context, Effect, Layer } from 'effect'
import type { AgentEvent, AgentMessage } from '@yolk/agent/protocol'
import type { ContextTransformError } from '../error.ts'

export type ContextTransformResult = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly events: ReadonlyArray<AgentEvent>
}

export class ContextTransformer extends Context.Service<
  ContextTransformer,
  {
    readonly transform: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<ContextTransformResult, ContextTransformError>
  }
>()('@yolk/agent/loop/ContextTransformer') {
  static identity = Layer.succeed(
    this,
    this.of({
      transform: messages => Effect.succeed({ messages, events: [] })
    })
  )
}
