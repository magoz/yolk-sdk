import { Context, Effect, Layer } from 'effect'
import type { AgentMessage } from '@yolk/protocol'

export class ContextTransformer extends Context.Service<
  ContextTransformer,
  {
    readonly transform: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<ReadonlyArray<AgentMessage>>
  }
>()('@yolk/harness/ContextTransformer') {
  static identity = Layer.succeed(
    this,
    this.of({
      transform: messages => Effect.succeed(messages)
    })
  )
}
