import { describe, expect, it } from '@effect/vitest'
import {
  AudioPart,
  ImagePart,
  TextPart,
  appendTextToContent,
  contentParts,
  contentPreview,
  contentText,
  isContentEmpty
} from '../../src/protocol'

describe('content helpers', () => {
  it('extracts text-only content', () => {
    const content = [
      TextPart.make({ text: 'hello ' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
      TextPart.make({ text: 'world' }),
      AudioPart.make({ data: 'def', format: 'wav' })
    ]

    expect(contentText(content)).toBe('hello world')
  })

  it('previews mixed content with stable labels', () => {
    const content = [
      TextPart.make({ text: 'look' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
      AudioPart.make({ data: 'def', format: 'mp3' })
    ]

    expect(contentPreview(content)).toBe('look, Image, Audio')
  })

  it('treats media parts as non-empty content', () => {
    expect(isContentEmpty('')).toBe(true)
    expect(isContentEmpty([TextPart.make({ text: '' })])).toBe(true)
    expect(isContentEmpty([ImagePart.make({ data: 'abc', mimeType: 'image/png' })])).toBe(false)
  })

  it('normalizes string content to text parts', () => {
    expect(contentParts('hello')).toEqual([TextPart.make({ text: 'hello' })])
  })

  it('appends text while preserving content shape', () => {
    expect(appendTextToContent('hel', 'lo')).toBe('hello')
    expect(
      appendTextToContent([ImagePart.make({ data: 'abc', mimeType: 'image/png' })], 'caption')
    ).toEqual([
      ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
      TextPart.make({ text: 'caption' })
    ])
    expect(appendTextToContent([TextPart.make({ text: 'hel' })], 'lo')).toEqual([
      TextPart.make({ text: 'hello' })
    ])
  })
})
