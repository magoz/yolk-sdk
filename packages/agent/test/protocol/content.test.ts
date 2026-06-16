import { Effect, Option } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AudioPart,
  DocumentPart,
  ImagePart,
  TextPart,
  appendTextToContent,
  attachmentSourceBase64,
  attachmentSourceDataUrl,
  attachmentSourcePreview,
  attachmentSourceText,
  contentParts,
  contentPreview,
  contentText,
  documentPartFromText,
  inferTextDocumentMimeType,
  inlineBase64AttachmentSource,
  inlineBase64Source,
  isContentEmpty,
  isTextDocumentMimeType,
  refAttachmentSource,
  resolveContentAttachmentSources,
  textDocumentMimeTypeFromFilename,
  textToBase64Utf8,
  urlAttachmentSource
} from '../../src/protocol'

describe('content helpers', () => {
  it('extracts text-only content', () => {
    const content = [
      TextPart.make({ text: 'hello ' }),
      ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
      DocumentPart.make({ source: inlineBase64Source('ghi='), mimeType: 'application/pdf', filename: 'brief.pdf' }),
      TextPart.make({ text: 'world' }),
      AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/wav' })
    ]

    expect(contentText(content)).toBe('hello world')
  })

  it('previews mixed content with stable labels', () => {
    const content = [
      TextPart.make({ text: 'look' }),
      ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
      DocumentPart.make({ source: inlineBase64Source('ghi='), mimeType: 'application/pdf', filename: 'brief.pdf' }),
      AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/mpeg' })
    ]

    expect(contentPreview(content)).toBe('look, Image, Document: brief.pdf, Audio')
  })

  it('treats media parts as non-empty content', () => {
    expect(isContentEmpty('')).toBe(true)
    expect(isContentEmpty([TextPart.make({ text: '' })])).toBe(true)
    expect(isContentEmpty([ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' })])).toBe(false)
    expect(isContentEmpty([DocumentPart.make({ source: inlineBase64Source('abc='), mimeType: 'application/pdf', filename: 'brief.pdf' })])).toBe(false)
  })

  it('normalizes string content to text parts', () => {
    expect(contentParts('hello')).toEqual([TextPart.make({ text: 'hello' })])
  })

  it('appends text while preserving content shape', () => {
    expect(appendTextToContent('hel', 'lo')).toBe('hello')
    expect(
      appendTextToContent([ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' })], 'caption')
    ).toEqual([
      ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
      TextPart.make({ text: 'caption' })
    ])
    expect(appendTextToContent([TextPart.make({ text: 'hel' })], 'lo')).toEqual([
      TextPart.make({ text: 'hello' })
    ])
  })

  it('builds attachment sources with stable helpers', () => {
    const inline = inlineBase64AttachmentSource('abc')
    const url = urlAttachmentSource('https://example.com/image.png')
    const ref = refAttachmentSource('artifact_123')

    expect(attachmentSourceBase64(inline)).toEqual(Option.some('abc'))
    expect(attachmentSourceDataUrl(inline, 'image/png')).toEqual(Option.some('data:image/png;base64,abc'))
    expect(attachmentSourceBase64(url)).toEqual(Option.none())
    expect(attachmentSourceDataUrl(ref, 'image/png')).toEqual(Option.none())
    expect(attachmentSourcePreview(inline)).toBe('inline')
    expect(attachmentSourcePreview(url)).toBe('https://example.com/image.png')
    expect(attachmentSourcePreview(ref)).toBe('artifact_123')
  })

  it.effect('decodes inline text document sources', () =>
    Effect.gen(function* () {
      const text = yield* attachmentSourceText(inlineBase64AttachmentSource(btoa('# Identity')))
      const unicode = 'Crème brûlée 🥚 — 東京'
      const unicodeText = yield* attachmentSourceText(
        inlineBase64AttachmentSource(textToBase64Utf8(unicode))
      )

      expect(text).toEqual(Option.some('# Identity'))
      expect(unicodeText).toEqual(Option.some(unicode))
      expect(isTextDocumentMimeType('text/markdown')).toBe(true)
      expect(isTextDocumentMimeType('APPLICATION/JSON; charset=utf-8')).toBe(true)
      expect(isTextDocumentMimeType('application/activity+json')).toBe(true)
      expect(isTextDocumentMimeType('application/x-ndjson')).toBe(true)
      expect(isTextDocumentMimeType('application/pdf')).toBe(false)
      expect(textDocumentMimeTypeFromFilename('company.identity.md')).toBe('text/markdown')
      expect(textDocumentMimeTypeFromFilename('events.jsonl')).toBe('application/x-ndjson')
      expect(inferTextDocumentMimeType({ filename: 'data.json', mimeType: '' })).toBe('application/json')
      expect(inferTextDocumentMimeType({ filename: 'data.jsonl', mimeType: 'application/octet-stream' })).toBe(
        'application/x-ndjson'
      )
      expect(inferTextDocumentMimeType({ filename: 'fake.txt', mimeType: 'image/png' })).toBeUndefined()
      expect(inferTextDocumentMimeType({ filename: 'data.bin', mimeType: 'TEXT/PLAIN; charset=utf-8' })).toBe(
        'text/plain'
      )
      expect(textToBase64Utf8('# Identity')).toBe('IyBJZGVudGl0eQ==')
      expect(
        documentPartFromText({
          text: '# Identity',
          filename: 'company.identity.md',
          mimeType: ''
        })
      ).toEqual(
        DocumentPart.make({
          source: inlineBase64AttachmentSource('IyBJZGVudGl0eQ=='),
          mimeType: 'text/markdown',
          filename: 'company.identity.md'
        })
      )
      expect(
        documentPartFromText({
          text: '# Identity',
          filename: 'company.identity.md',
          mimeType: 'image/png'
        })
      ).toBeUndefined()
      expect(
        documentPartFromText({
          text: '# Identity',
          filename: 'company.identity',
          mimeType: ''
        })
      ).toEqual(
        DocumentPart.make({
          source: inlineBase64AttachmentSource('IyBJZGVudGl0eQ=='),
          mimeType: 'text/plain',
          filename: 'company.identity'
        })
      )
    }))

  it.effect('resolves attachment sources while preserving part metadata', () =>
    Effect.gen(function* () {
      const content = [
        TextPart.make({ text: 'inspect' }),
        ImagePart.make({
          source: refAttachmentSource('image_1'),
          mimeType: 'image/png',
          filename: 'photo.png',
          title: 'Photo',
          width: 320,
          height: 240
        }),
        DocumentPart.make({
          source: urlAttachmentSource('https://example.com/brief.pdf'),
          mimeType: 'application/pdf',
          filename: 'brief.pdf',
          title: 'Brief'
        }),
        AudioPart.make({
          source: refAttachmentSource('audio_1'),
          mimeType: 'audio/mpeg',
          filename: 'clip.mp3',
          durationMs: 1200
        })
      ]

      const resolved = yield* resolveContentAttachmentSources(content, part => {
        switch (part._tag) {
          case 'Image':
            return Effect.succeed(inlineBase64AttachmentSource('image-data'))
          case 'Document':
            return Effect.succeed(inlineBase64AttachmentSource('document-data'))
          case 'Audio':
            return Effect.succeed(inlineBase64AttachmentSource('audio-data'))
        }
      })

      expect(resolved).toEqual([
        TextPart.make({ text: 'inspect' }),
        ImagePart.make({
          source: inlineBase64AttachmentSource('image-data'),
          mimeType: 'image/png',
          filename: 'photo.png',
          title: 'Photo',
          width: 320,
          height: 240
        }),
        DocumentPart.make({
          source: inlineBase64AttachmentSource('document-data'),
          mimeType: 'application/pdf',
          filename: 'brief.pdf',
          title: 'Brief'
        }),
        AudioPart.make({
          source: inlineBase64AttachmentSource('audio-data'),
          mimeType: 'audio/mpeg',
          filename: 'clip.mp3',
          durationMs: 1200
        })
      ])
    }))
})
