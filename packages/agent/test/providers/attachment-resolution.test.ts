import { Effect, Ref, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  AudioPart,
  DocumentPart,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  refAttachmentSource,
  resolveMessagesAttachmentSources,
  urlAttachmentSource,
  type AgentMessage,
  type AttachmentContentPart
} from '@yolk-sdk/agent/protocol'
import { LLMError, LLMProvider, LLMTextDelta, type LLMRequest } from '@yolk-sdk/agent/loop'
import { makeContextOverflowRetryProvider } from '@yolk-sdk/agent/compaction'
import { toAnthropicClaudeRequestBody } from '../../src/providers/anthropic/claude-provider.ts'
import { toOpenAiCodexRequestBody } from '../../src/providers/openai/codex-provider.ts'

const pdf = DocumentPart.make({
  source: refAttachmentSource('pdf'),
  mimeType: 'application/pdf',
  filename: 'brief.pdf'
})
const image = ImagePart.make({ source: refAttachmentSource('image'), mimeType: 'image/png' })
const hostCall = AssistantAgentMessage.make({
  parts: [
    HostToolCallPart.make({ call: ToolCall.make({ id: 'call-1', name: 'read', params: {} }) })
  ]
})
const toolResult = (content: ReadonlyArray<AttachmentContentPart>) =>
  ToolResultMessage.make({
    toolCallId: 'call-1',
    createdAtMs: 0,
    author: { displayName: 'Reader' },
    annotations: { source: 'private' },
    content: [TextPart.make({ text: 'Attachments:' }), ...content]
  })
const request = (messages: ReadonlyArray<AgentMessage>): LLMRequest => ({
  messages,
  model: 'test-model',
  systemPrompt: 'Inspect attachments',
  tools: [],
  reasoningEffort: 'medium'
})
const signedUrl = (id: string, attempt: number) => `https://example.com/${id}?attempt=${attempt}`
const overflow = new LLMError({ cause: 'context_overflow', message: 'too large', retryable: false })

const providers = [
  {
    name: 'Claude',
    lower: (input: LLMRequest): Effect.Effect<unknown, LLMError> =>
      toAnthropicClaudeRequestBody(input, { maxTokens: 1024 }),
    expected: (attempt: number) => ({
      messages: expect.arrayContaining([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              is_error: undefined,
              content: [
                { type: 'text', text: expect.stringContaining('author: Reader') },
                { type: 'text', text: 'Attachments:' },
                { type: 'image', source: { type: 'url', url: signedUrl('image', attempt) } },
                {
                  type: 'document',
                  source: { type: 'url', url: signedUrl('pdf', attempt) },
                  title: 'brief.pdf'
                }
              ]
            }
          ]
        }
      ])
    })
  },
  {
    name: 'Codex',
    lower: (input: LLMRequest): Effect.Effect<unknown, LLMError> => toOpenAiCodexRequestBody(input),
    expected: (attempt: number) => ({
      input: expect.arrayContaining([
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: [
            { type: 'input_text', text: expect.stringContaining('author: Reader') },
            { type: 'input_text', text: 'Attachments:' },
            { type: 'input_image', image_url: signedUrl('image', attempt) },
            { type: 'input_file', file_url: signedUrl('pdf', attempt) }
          ]
        }
      ])
    })
  }
]

for (const provider of providers) {
  describe(`${provider.name} private attachments`, () => {
    it.effect(
      'resolves native tool results afresh inside every overflow retry, without changing history',
      () =>
        Effect.gen(function* () {
          const oldPdf = DocumentPart.make({ ...pdf, source: refAttachmentSource('old-pdf') })
          const original = [
            UserMessage.make({ content: [oldPdf] }),
            hostCall,
            toolResult([image, pdf])
          ]
          const snapshot = yield* resolveMessagesAttachmentSources(original, part =>
            Effect.succeed(part.source)
          )
          const compacted = [UserMessage.make({ content: 'Checkpoint' }), ...original.slice(1)]
          const messagesRef = yield* Ref.make<ReadonlyArray<AgentMessage>>(original)
          const compactCalls: Array<ReadonlyArray<AgentMessage>> = []
          const prepared: Array<ReadonlyArray<AgentMessage>> = []
          const visits: Array<string> = []
          let attempts = 0
          let transports = 0
          const transport = LLMProvider.of({
            stream: input =>
              Stream.unwrap(
                Effect.gen(function* () {
                  transports++
                  expect(input).toMatchObject({ ...request(input.messages) })
                  const body = yield* provider.lower(input)
                  expect(body).toMatchObject(provider.expected(attempts))
                  return transports % 2 === 1
                    ? Stream.fail(overflow)
                    : Stream.make(LLMTextDelta.make({ text: 'ok' }))
                })
              )
          })
          // Host-owned composition: retry -> policy/resolution -> actual provider.
          const resolvingProvider = LLMProvider.of({
            stream: input =>
              Stream.unwrap(
                Effect.gen(function* () {
                  attempts++
                  prepared.push(input.messages)
                  const messages = yield* resolveMessagesAttachmentSources(input.messages, part => {
                    const source = part.source
                    if (source._tag !== 'Ref') return Effect.succeed(source)
                    visits.push(source.id)
                    return Effect.succeed(urlAttachmentSource(signedUrl(source.id, attempts)))
                  })
                  return transport.stream({ ...input, messages })
                })
              )
          })
          const retryProvider = yield* makeContextOverflowRetryProvider({
            provider: resolvingProvider,
            messagesRef,
            compact: messages =>
              Effect.sync(() => {
                compactCalls.push(messages)
                return { _tag: 'Compacted', messages: compacted }
              })
          })
          const stream = retryProvider.stream(request(original))
          expect(attempts).toBe(0)
          for (let run = 0; run < 2; run++) {
            const events = yield* stream.pipe(Stream.runCollect)
            expect(Array.from(events)).toEqual([LLMTextDelta.make({ text: 'ok' })])
          }
          yield* retryProvider.stream(request(original)).pipe(Stream.runDrain)
          expect(attempts).toBe(6)
          expect(transports).toBe(6)
          expect(compactCalls).toEqual([original, original, original])
          expect(prepared).toEqual([original, compacted, original, compacted, original, compacted])
          expect(visits).toEqual(
            Array.from({ length: 3 }, () => ['old-pdf', 'image', 'pdf', 'image', 'pdf']).flat()
          )
          expect(original).toEqual(snapshot)
          expect(yield* Ref.get(messagesRef)).toBe(compacted)
          expect(compacted[2]).toBe(original[2])
        })
    )

    for (const part of [
      image,
      pdf,
      AudioPart.make({
        source: urlAttachmentSource('https://example.com/audio'),
        mimeType: 'audio/wav'
      })
    ]) {
      it.effect(
        `rejects ${part._tag === 'Audio' ? 'unsupported audio' : `unresolved ${part._tag} Ref`} tool-result content`,
        () =>
          Effect.gen(function* () {
            const error = yield* provider
              .lower(request([hostCall, toolResult([part])]))
              .pipe(Effect.flip)
            expect(error).toMatchObject({ _tag: 'LLMError', retryable: false })
            expect(error.message).toContain(
              part._tag === 'Audio'
                ? 'Audio content'
                : `Unresolved ${part._tag.toLowerCase()} source`
            )
          })
      )
    }

    it.effect('does not imply assistant media support merely because sources were resolved', () =>
      Effect.gen(function* () {
        const messages = yield* resolveMessagesAttachmentSources(
          [AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: [pdf] })] })],
          () => Effect.succeed(urlAttachmentSource(signedUrl('pdf', 1)))
        )
        const error = yield* provider.lower(request(messages)).pipe(Effect.flip)
        expect(error.message).toContain('Assistant document content is not supported')
      })
    )

    it.effect('does not call the provider or compactor after a host resolver failure', () =>
      Effect.gen(function* () {
        const failure = new LLMError({
          cause: 'validation_error',
          message: 'Attachment unavailable',
          retryable: false
        })
        let transports = 0
        let compactions = 0
        const retryProvider = yield* makeContextOverflowRetryProvider({
          provider: LLMProvider.of({
            stream: input =>
              Stream.unwrap(
                resolveMessagesAttachmentSources(input.messages, () => Effect.fail(failure)).pipe(
                  Effect.map(messages => {
                    transports++
                    return Stream.fromEffect(provider.lower({ ...input, messages })).pipe(
                      Stream.drain
                    )
                  })
                )
              )
          }),
          compact: messages =>
            Effect.sync(() => {
              compactions++
              return { _tag: 'Compacted', messages }
            })
        })
        const error = yield* retryProvider
          .stream(request([hostCall, toolResult([pdf])]))
          .pipe(Stream.runDrain, Effect.flip)
        expect(error).toBe(failure)
        expect(transports).toBe(0)
        expect(compactions).toBe(0)
      })
    )
  })
}
