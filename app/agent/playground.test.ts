import { describe, expect, it } from '@effect/vitest'
import { ImagePart, TextPart } from '@yolk/protocol'
import { contentFromInput, type ImageAttachment } from './image-attachment-content'

const imageAttachment: ImageAttachment = {
  id: 'image-1',
  name: 'image.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,abc',
  data: 'abc'
}

const secondImageAttachment: ImageAttachment = {
  id: 'image-2',
  name: 'image-2.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,def',
  data: 'def'
}

describe('agent playground', () => {
  it('builds text-only submit content', () => {
    expect(contentFromInput(' hello ', [])).toBe('hello')
  })

  it('builds multipart image submit content', () => {
    expect(contentFromInput(' describe ', [imageAttachment])).toEqual([
      TextPart.make({ text: 'describe' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' })
    ])
  })

  it('builds image-only submit content', () => {
    expect(contentFromInput('   ', [imageAttachment])).toEqual([
      ImagePart.make({ data: 'abc', mimeType: 'image/png' })
    ])
  })

  it('builds multi-image submit content', () => {
    expect(contentFromInput(' compare ', [imageAttachment, secondImageAttachment])).toEqual([
      TextPart.make({ text: 'compare' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
      ImagePart.make({ data: 'def', mimeType: 'image/png' })
    ])
  })
})
