import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  DocumentPart,
  TextPart,
  UserMessage,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import { toOpenAiRequestBody } from '../../../src/providers/openai/provider.ts'

describe('OpenAI provider', () => {
  it.effect('inlines text documents for Chat Completions input', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: inlineBase64Source(btoa('# Identity\n\nSpeldosa docs.')),
                mimeType: 'text/markdown; charset=utf-8',
                filename: 'company.identity.md'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'summarize' },
          { type: 'text', text: 'Document: company.identity.md\n\n# Identity\n\nSpeldosa docs.' }
        ]
      })
    }))
})
