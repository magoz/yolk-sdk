import { describe, expect, it } from 'vitest'
import { knowledgeArtifactStorageKey } from './live-layer'

describe('knowledgeArtifactStorageKey', () => {
  it('builds stable original artifact keys', () => {
    expect(
      knowledgeArtifactStorageKey({ recordId: 'obj_1', artifactId: 'art_1', kind: 'original' })
    ).toBe('knowledge/obj_1/original/art_1')
  })

  it('builds stable derived artifact keys', () => {
    expect(
      knowledgeArtifactStorageKey({ recordId: 'obj_1', artifactId: 'art_2', kind: 'extracted_text' })
    ).toBe('knowledge/obj_1/derived/text/art_2.txt')
    expect(
      knowledgeArtifactStorageKey({ recordId: 'obj_1', artifactId: 'art_3', kind: 'thumbnail', extension: '.webp' })
    ).toBe('knowledge/obj_1/derived/thumb/art_3.webp')
  })
})
