import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { chunkKnowledgeText } from '../src/chunking.ts'
import { KnowledgeDocumentId, KnowledgeScopeId } from '../src/documents.ts'

const chunk = (content: string, maxTokens: number) =>
  chunkKnowledgeText(
    {
      scopeId: KnowledgeScopeId.make('scope_1'),
      documentId: KnowledgeDocumentId.make('doc_1'),
      content
    },
    maxTokens
  )

const words = (text: string) => text.split(/\s+/).filter(word => word.length > 0)

describe('default chunker', () => {
  it.effect('keeps the spaces between the pieces of an oversized sentence and what follows', () =>
    Effect.gen(function* () {
      const content =
        'One two three four five six seven eight nine ten eleven twelve thirteen fourteen. ' +
        'Then more.'

      const chunks = yield* chunk(content, 12)

      expect(chunks.map(({ content }) => content)).toEqual([
        'One two three four five six',
        'seven eight nine ten eleven twelve thirteen fourteen.',
        'Then more.'
      ])
      expect(words(chunks.map(({ content }) => content).join(' '))).toEqual(words(content))
    })
  )

  it.effect('keeps the space after a word split by tokens', () =>
    Effect.gen(function* () {
      const content =
        'Look: supercalifragilisticexpialidocious-antidisestablishmentarianism words follow it.'

      const chunks = yield* chunk(content, 12)

      expect(chunks.map(({ content }) => content)).toEqual([
        'Look:',
        'supercalifragilisticexpialidocious-antidis',
        'establishmentarianism words follow it.'
      ])
      expect(chunks.every(({ tokenCount }) => tokenCount <= 12)).toBe(true)
    })
  )
})
