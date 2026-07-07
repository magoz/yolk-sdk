import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { DocumentPart, inlineBase64AttachmentSource } from '@yolk-sdk/agent/protocol'
import {
  documentPartFromTextFile,
  documentPartFromTextFileEffect,
  textFromBlob,
  textFromBlobEffect
} from '../../src/client'

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

  it.effect('exposes Effect-native text attachment helpers', () =>
    Effect.gen(function* () {
      const file = new File(['hello'], 'notes.txt', { type: '' })

      const text = yield* textFromBlobEffect(file)
      const part = yield* documentPartFromTextFileEffect(file)

      expect(text).toBe('hello')
      expect(part).toEqual(
        DocumentPart.make({
          source: inlineBase64AttachmentSource('aGVsbG8='),
          mimeType: 'text/plain',
          filename: 'notes.txt'
        })
      )
    }))
})
