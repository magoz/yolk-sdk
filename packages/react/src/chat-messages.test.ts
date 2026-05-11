import { describe, expect, it } from '@effect/vitest'
import { ImagePart, TextPart } from '@yolk/protocol'
import { toAgentMessages, type AgentChatMessage } from './chat-messages'

describe('agent chat messages', () => {
  it('preserves multipart user content for protocol replay', () => {
    const chatMessages: ReadonlyArray<AgentChatMessage> = [
      {
        id: 'message-0-user',
        role: 'user',
        parts: [
          {
            _tag: 'Text',
            id: 'message-0-user-content',
            content: [
              TextPart.make({ text: 'describe this' }),
              ImagePart.make({ data: 'abc', mimeType: 'image/png' })
            ],
            state: 'done'
          }
        ]
      }
    ]

    expect(toAgentMessages(chatMessages)).toEqual([
      {
        _tag: 'User',
        content: [
          TextPart.make({ text: 'describe this' }),
          ImagePart.make({ data: 'abc', mimeType: 'image/png' })
        ]
      }
    ])
  })
})
