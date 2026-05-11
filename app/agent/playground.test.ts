import { describe, expect, it } from '@effect/vitest'
import { ImagePart, TextPart } from '@yolk/protocol'
import { contentFromInput, type ImageAttachment } from './image-attachment-content'

const imageAttachment: ImageAttachment = {
  name: 'image.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,abc',
  data: 'abc'
}

describe('agent playground', () => {
  it('builds text-only submit content', () => {
    expect(contentFromInput(' hello ', null)).toBe('hello')
  })

  it('builds multipart image submit content', () => {
    expect(contentFromInput(' describe ', imageAttachment)).toEqual([
      TextPart.make({ text: 'describe' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' })
    ])
  })

  it('builds image-only submit content', () => {
    expect(contentFromInput('   ', imageAttachment)).toEqual([
      ImagePart.make({ data: 'abc', mimeType: 'image/png' })
    ])
  })
})
