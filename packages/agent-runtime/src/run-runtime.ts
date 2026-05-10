import { Effect, Stream } from 'effect'
import type { AgentEvent, AgentMessage, ToolDef } from '@yolk/protocol'
import {
  run,
  type AgentLoopError,
  type ContextTransformer,
  type LLMProvider,
  type LoopConfig,
  type ToolExecutor
} from '@yolk/agent-loop'
import { SessionStore } from './session-store'
import type { RuntimeError } from './error'

export type RuntimeRequest<Ctx> = {
  readonly sessionId: string
  readonly input: AgentMessage
  readonly context: Ctx
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
}

const extractNewMessages = (event: AgentEvent) => (event._tag === 'AgentEnd' ? event.messages : [])

export const runRuntime = <Ctx>(
  request: RuntimeRequest<Ctx>
): Stream.Stream<
  AgentEvent,
  RuntimeError | AgentLoopError,
  ContextTransformer | LLMProvider | LoopConfig | SessionStore | ToolExecutor
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const snapshot = yield* store.load(request.sessionId)
      const createdMessages: Array<AgentMessage> = []

      return run({
        messages: [...snapshot.messages, request.input],
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        model: request.model
      }).pipe(
        Stream.tap(event =>
          Effect.sync(() => {
            createdMessages.push(...extractNewMessages(event))
          })
        ),
        Stream.ensuring(
          Effect.gen(function* () {
            yield* store.save({
              id: snapshot.id,
              messages: [...snapshot.messages, request.input, ...createdMessages]
            })
          })
        )
      )
    })
  )
