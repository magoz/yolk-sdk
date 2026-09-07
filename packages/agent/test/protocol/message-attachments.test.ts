import { Context, Data, Effect, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentMessage,
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  AudioPart,
  DocumentPart,
  HostToolCallPart,
  ImagePart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  TextPart,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  inlineBase64AttachmentSource,
  refAttachmentSource,
  resolveMessageAttachmentSources,
  resolveMessagesAttachmentSources,
  urlAttachmentSource,
  type AttachmentSource,
  type AttachmentSourceResolver
} from '@yolk-sdk/agent/protocol'

const envelope = {
  createdAtMs: 123456,
  author: { displayName: 'Reader' },
  annotations: { provenance: { trusted: false }, labels: ['attachment'] }
}
const opaque = { _tag: 'Image', source: { _tag: 'Ref', id: 'do-not-traverse' } }
const call = ToolCall.make({ id: 'call-1', name: 'inspect', params: opaque })
const reasoning = AssistantReasoningPart.make({ text: 'Visible reasoning summary' })
const hostCall = HostToolCallPart.make({ call })
const providerCall = ProviderToolCallPart.make({ call, providerMetadata: opaque })

const transcript = (source: (id: string) => AttachmentSource): ReadonlyArray<AgentMessage> => {
  const pdf = DocumentPart.make({
    source: source('pdf'),
    mimeType: 'application/pdf',
    filename: 'brief.pdf',
    title: 'Brief'
  })
  const image = ImagePart.make({
    source: source('image'),
    mimeType: 'image/png',
    filename: 'photo.png',
    title: 'Photo',
    width: 320,
    height: 240
  })
  const audio = AudioPart.make({
    source: source('audio'),
    mimeType: 'audio/wav',
    filename: 'clip.wav',
    durationMs: 1200
  })

  return [
    UserMessage.make({ ...envelope, content: [TextPart.make({ text: 'Inspect' }), pdf, image] }),
    AssistantAgentMessage.make({
      ...envelope,
      parts: [
        reasoning,
        AssistantTextPart.make({ content: [image, TextPart.make({ text: 'Found' })] }),
        hostCall,
        providerCall,
        ProviderToolResultPart.make({
          toolCallId: call.id,
          result: ToolResult.make({
            toolCallId: call.id,
            content: [pdf, audio],
            isError: true,
            structuredContent: opaque
          }),
          providerMetadata: opaque
        }),
        AssistantTextPart.make({ content: 'Done' })
      ]
    }),
    ToolResultMessage.make({
      ...envelope,
      toolCallId: call.id,
      content: [TextPart.make({ text: 'Result' }), image, pdf],
      isError: true,
      structuredContent: opaque
    })
  ]
}

class ResolutionError extends Data.TaggedError('ResolutionError')<{
  readonly id: string
}> {}

class AttachmentSigner extends Context.Service<
  AttachmentSigner,
  { readonly sign: (id: string) => Effect.Effect<AttachmentSource, ResolutionError> }
>()('test/AttachmentSigner') {}

const resolve: AttachmentSourceResolver<ResolutionError, AttachmentSigner> = part =>
  Effect.gen(function* () {
    const source = part.source
    if (source._tag !== 'Ref') return source
    const signer = yield* AttachmentSigner
    return yield* signer.sign(source.id)
  })

const signed = (id: string) => urlAttachmentSource(`https://example.com/${id}?signature=fresh`)

describe('message attachment resolution', () => {
  it.effect('walks all protocol content in order, preserving envelopes and opaque payloads', () =>
    Effect.gen(function* () {
      const original = transcript(refAttachmentSource)
      const visits: Array<string> = []
      const program: Effect.Effect<
        ReadonlyArray<AgentMessage>,
        ResolutionError,
        AttachmentSigner
      > = resolveMessagesAttachmentSources(original, resolve)
      const resolved = yield* program.pipe(
        Effect.provideService(AttachmentSigner, {
          sign: id =>
            Effect.sync(() => {
              visits.push(id)
              return signed(id)
            })
        })
      )

      expect(visits).toEqual(['pdf', 'image', 'image', 'pdf', 'audio', 'image', 'pdf'])
      expect(resolved).toEqual(transcript(signed))
      expect(original).toEqual(transcript(refAttachmentSource))
      const assistant = resolved[1]
      expect(assistant?._tag).toBe('Assistant')
      if (assistant?._tag === 'Assistant') {
        expect(assistant.parts[0]).toBe(reasoning)
        expect(assistant.parts[2]).toBe(hostCall)
        expect(assistant.parts[3]).toBe(providerCall)
        const result = assistant.parts[4]
        if (result?._tag === 'ProviderToolResult') {
          expect(result.providerMetadata).toBe(opaque)
          expect(result.result.structuredContent).toBe(opaque)
        }
      }
      const encoded = yield* Schema.encodeEffect(Schema.Array(AgentMessage))(resolved)
      expect(yield* Schema.decodeUnknownEffect(Schema.Array(AgentMessage))(encoded)).toEqual(
        resolved
      )
    })
  )

  it.effect('leaves string/empty content alone and lets the host handle every source kind', () =>
    Effect.gen(function* () {
      const messages = [
        UserMessage.make({ content: 'hello' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: [] })] }),
        ToolResultMessage.make({ toolCallId: call.id, content: '' })
      ]
      const visits: Array<AttachmentSource['_tag']> = []
      const passthrough: AttachmentSourceResolver = part =>
        Effect.sync(() => {
          visits.push(part.source._tag)
          return part.source
        })
      expect(yield* resolveMessagesAttachmentSources(messages, passthrough)).toEqual(messages)
      expect(visits).toEqual([])
      expect(yield* resolveMessagesAttachmentSources([], passthrough)).toEqual([])

      const message = UserMessage.make({
        content: [
          refAttachmentSource('private'),
          signed('public'),
          inlineBase64AttachmentSource('AA==')
        ].map(source => ImagePart.make({ source, mimeType: 'image/png' }))
      })
      expect(yield* resolveMessageAttachmentSources(message, passthrough)).toEqual(message)
      expect(visits).toEqual(['Ref', 'Url', 'InlineBase64'])
    })
  )

  it.effect('propagates the exact typed failure and stops before later attachments', () =>
    Effect.gen(function* () {
      const original = transcript(refAttachmentSource)
      const failure = new ResolutionError({ id: 'image' })
      const visits: Array<string> = []
      const error = yield* resolveMessagesAttachmentSources(original, resolve).pipe(
        Effect.provideService(AttachmentSigner, {
          sign: id =>
            Effect.gen(function* () {
              visits.push(id)
              return id === 'image' ? yield* Effect.fail(failure) : signed(id)
            })
        }),
        Effect.flip
      )
      expect(error).toBe(failure)
      expect(visits).toEqual(['pdf', 'image'])
      expect(original).toEqual(transcript(refAttachmentSource))
    })
  )

  it.effect('resolves again whenever the same Effect is executed', () =>
    Effect.gen(function* () {
      let calls = 0
      const original = ToolResultMessage.make({
        toolCallId: call.id,
        content: [ImagePart.make({ source: refAttachmentSource('private'), mimeType: 'image/png' })]
      })
      const program = resolveMessageAttachmentSources(original, part =>
        Effect.sync(() => {
          calls++
          return urlAttachmentSource(`https://example.com/${part._tag}?attempt=${calls}`)
        })
      )
      const first = yield* program
      const second = yield* program
      expect(calls).toBe(2)
      expect(first).not.toEqual(second)
      expect(original.content).toEqual([
        ImagePart.make({ source: refAttachmentSource('private'), mimeType: 'image/png' })
      ])
    })
  )
})
