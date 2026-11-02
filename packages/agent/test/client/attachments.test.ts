import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { DocumentPart, inlineBase64AttachmentSource } from '@yolk-sdk/agent/protocol'
import { BlobTextReadError, documentPartFromTextFile, textFromBlob } from '../../src/client'

describe('client attachment helpers', () => {
  it.effect('fails with BlobTextReadError keeping the read failure as cause', () =>
    Effect.gen(function* () {
      const failure = new Error('disk unavailable')

      class FailingBlob extends Blob {
        override text() {
          return Promise.reject(failure)
        }
      }

      const error = yield* textFromBlob(new FailingBlob(['hello'])).pipe(Effect.flip)

      expect(error).toBeInstanceOf(BlobTextReadError)
      expect(error.message).toBe('Could not read text')
      expect(error.cause).toBe(failure)
    })
  )

  it('builds document parts from text files without browser mime type', async () => {
    const file = new File(['# Identity'], 'company.identity.md', { type: '' })

    await expect(Effect.runPromise(textFromBlob(file))).resolves.toBe('# Identity')
    await expect(
      Effect.runPromise(documentPartFromTextFile(file, { title: 'Identity' }))
    ).resolves.toEqual(
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

    await expect(Effect.runPromise(documentPartFromTextFile(file))).resolves.toBeUndefined()
    await expect(
      Effect.runPromise(documentPartFromTextFile(disguisedFile))
    ).resolves.toBeUndefined()
  })

  it.effect('exposes Effect-native text attachment helpers', () =>
    Effect.gen(function* () {
      const file = new File(['hello'], 'notes.txt', { type: '' })

      const text = yield* textFromBlob(file)
      const part = yield* documentPartFromTextFile(file)

      expect(text).toBe('hello')
      expect(part).toEqual(
        DocumentPart.make({
          source: inlineBase64AttachmentSource('aGVsbG8='),
          mimeType: 'text/plain',
          filename: 'notes.txt'
        })
      )
    })
  )
})
