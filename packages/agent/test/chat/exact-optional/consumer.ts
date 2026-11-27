// Compiled with `exactOptionalPropertyTypes`, as hosts may (`../exact-optional-consumer.test.ts`):
// the chat functions must take the states the package's own Schemas type.
import {
  type AgentChatEventProjectionState,
  type AgentChatState,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  markChatRunStart
} from '../../../src/chat/index.ts'

const projection: AgentChatEventProjectionState = makeAgentChatEventProjectionState()

const chat: AgentChatState = initialAgentChatState

export const markedProjection = markChatRunStart(projection)

export const markedChat = markChatRunStart(chat)
