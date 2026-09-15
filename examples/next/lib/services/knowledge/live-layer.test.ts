import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { knowledgeDocumentFromRow, knowledgeFileFromRow } from './document-rows'
import { knowledgeFileStorageKey } from './live-layer'

describe('knowledgeFileStorageKey', () => {
  it('builds stable original file keys', () => {
    expect(
      knowledgeFileStorageKey({ documentId: 'obj_1', fileId: 'file_1', kind: 'original' })
    ).toBe('knowledge/obj_1/original/file_1')
  })

  it('builds stable derived file keys', () => {
    expect(
      knowledgeFileStorageKey({ documentId: 'obj_1', fileId: 'file_2', kind: 'extracted_text' })
    ).toBe('knowledge/obj_1/derived/text/file_2.txt')
    expect(
      knowledgeFileStorageKey({
        documentId: 'obj_1',
        fileId: 'file_3',
        kind: 'thumbnail',
        extension: '.webp'
      })
    ).toBe('knowledge/obj_1/derived/thumb/file_3.webp')
  })
})

describe('knowledgeDocumentFromRow metadata', () => {
  const createdAt = new Date('2020-01-01T00:00:00.000Z')

  const document = {
    id: 'doc_1',
    userId: 'user_1',
    slug: 'notes',
    title: 'Notes',
    purpose: 'note',
    origin: 'manual_text',
    content: 'hello',
    status: 'ready' as const,
    availability: 'searchable' as const,
    summary: null,
    errorMessage: null,
    reviewedAt: null,
    metadata: { source: 'manual_text', extra: true },
    createdAt,
    updatedAt: createdAt
  }

  it.effect('decodes open-key metadata onto the domain document', () =>
    Effect.gen(function* () {
      const reconstructed = yield* knowledgeDocumentFromRow({ document })

      expect(reconstructed.metadata).toEqual({ source: 'manual_text', extra: true })
    })
  )

  it.effect('fails invalid metadata as KnowledgeStoreError instead of {}', () =>
    Effect.gen(function* () {
      const error = yield* knowledgeDocumentFromRow({
        document: { ...document, metadata: 'private-invalid-metadata' }
      }).pipe(Effect.flip)

      expect(error._tag).toBe('KnowledgeStoreError')
      expect(error.message).toContain('Invalid knowledge metadata')
      expect(error.message).not.toContain('private-invalid-metadata')
    })
  )
})

describe('knowledgeFileFromRow metadata', () => {
  const file = {
    id: 'file_1',
    documentId: 'doc_1',
    storageKey: 'knowledge/doc_1/original/file_1',
    mediaType: 'application/pdf',
    byteSize: 12,
    checksum: null,
    metadata: { filename: 'a.pdf', format: 'pdf' },
    createdAt: new Date('2020-01-01T00:00:00.000Z')
  }

  it.effect('decodes valid file metadata', () =>
    Effect.gen(function* () {
      const reconstructed = yield* knowledgeFileFromRow(file)

      expect(reconstructed.metadata).toEqual({ filename: 'a.pdf', format: 'pdf' })
    })
  )

  it.effect('fails invalid file metadata as KnowledgeStoreError', () =>
    Effect.gen(function* () {
      const error = yield* knowledgeFileFromRow({ ...file, metadata: [1] }).pipe(Effect.flip)

      expect(error._tag).toBe('KnowledgeStoreError')
      expect(error.message).toContain('Invalid knowledge metadata')
    })
  )
})
