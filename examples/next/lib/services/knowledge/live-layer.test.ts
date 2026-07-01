import { describe, expect, it } from 'vitest'
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
      knowledgeFileStorageKey({ documentId: 'obj_1', fileId: 'file_3', kind: 'thumbnail', extension: '.webp' })
    ).toBe('knowledge/obj_1/derived/thumb/file_3.webp')
  })
})
