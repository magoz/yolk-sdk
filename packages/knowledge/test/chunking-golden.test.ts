import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { chunkKnowledgeText, countKnowledgeChunkTokens } from '../src/chunking.ts'
import { KnowledgeDocumentId, KnowledgeScopeId } from '../src/documents.ts'

/**
 * Golden `o200k_base` output for the default chunker. Stored chunk boundaries and token counts
 * must not move when `gpt-tokenizer` is upgraded; a failure here means existing indexes would
 * chunk differently after the upgrade.
 */
describe('default chunker golden output', () => {
  it.effect('counts tokens across scripts, emoji, code, and long words', () =>
    Effect.gen(function* () {
      const counts = yield* Effect.all(
        [
          'The quick brown fox jumps over the lazy dog.',
          'Größenverhältnisse: 東京は日本の首都です。 Привет, мир!',
          'Emoji 🚀🔥👩‍💻 and accents: café naïve résumé',
          'const sum = (a: number, b: number): number => a + b\n\nexport { sum }',
          'supercalifragilisticexpialidocious-antidisestablishmentarianism_pneumonoultramicroscopic'
        ].map(countKnowledgeChunkTokens)
      )

      expect(counts).toEqual([10, 20, 16, 22, 24])
    })
  )

  it.effect('splits paragraphs, sentences, and oversized words at the same boundaries', () =>
    Effect.gen(function* () {
      const chunks = yield* chunkKnowledgeText(
        {
          scopeId: KnowledgeScopeId.make('scope_1'),
          documentId: KnowledgeDocumentId.make('doc_1'),
          content: [
            'Knowledge chunking splits text at paragraph breaks first. Then it splits at sentences!',
            'A second paragraph follows here? Yes: it does.',
            'Oversized: supercalifragilisticexpialidocious-antidisestablishmentarianism_pneumonoultramicroscopic words get split by tokens.'
          ].join('\n\n')
        },
        12
      )

      expect(chunks.map(chunk => [chunk.content, chunk.tokenCount])).toEqual([
        ['Knowledge chunking splits text at paragraph breaks first.', 10],
        ['Then it splits at sentences!', 6],
        ['A second paragraph follows here? Yes: it does.', 11],
        ['Oversized:', 3],
        ['supercalifragilisticexpialidocious-antidis', 12],
        ['establishmentarianism_pneumonoultramicroscopic', 12],
        ['words get split by tokens.', 6]
      ])
    })
  )
})
