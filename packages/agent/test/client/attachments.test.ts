import { describe, expect, it } from '@effect/vitest'
import { DocumentPart, inlineBase64AttachmentSource } from '@yolk-sdk/agent/protocol'
import { documentPartFromTextFile, textFromBlob } from '../../src/client'

describe('client attachment helpers', () => {
  it('builds document parts from text files without browser mime type', async () => {
    const file = new File(['# Identity'], 'company.identity.md', { type: '' })

    await expect(textFromBlob(file)).resolves.toBe('# Identity')
    await expect(documentPartFromTextFile(file, { title: 'Identity' })).resolves.toEqual(
      DocumentPart.make({
        source: inlineBase64AttachmentSource('IyBJZGVudGl0eQ=='),
        mimeType: 'text/markdown',
        filename: 'company.identity.md',
        title: 'Identity'
      })
    )
  })

  it('ignores non-text files', async () => {
    const file = new File(['data'], 'photo.png', { type: 'image/png' })
    const disguisedFile = new File(['data'], 'photo.txt', { type: 'image/png' })

    await expect(documentPartFromTextFile(file)).resolves.toBeUndefined()
    await expect(documentPartFromTextFile(disguisedFile)).resolves.toBeUndefined()
  })
})
