import type { RagChunk, RagDocument } from './documents.ts'

export type Chunker = {
  readonly chunk: (document: RagDocument) => ReadonlyArray<RagChunk>
}

export type CharacterChunkerOptions = {
  readonly size: number
  readonly overlap: number
}

const positiveIntegerOr = (value: number, fallback: number) =>
  Number.isInteger(value) && value > 0 ? value : fallback

const nonNegativeIntegerOr = (value: number, fallback: number) =>
  Number.isInteger(value) && value >= 0 ? value : fallback

const chunkText = (text: string, options: CharacterChunkerOptions): ReadonlyArray<string> => {
  const size = positiveIntegerOr(options.size, 1200)
  const overlap = Math.min(nonNegativeIntegerOr(options.overlap, 0), size - 1)
  const step = size - overlap
  const chunks: Array<string> = []

  let start = 0
  while (start < text.length) {
    const end = Math.min(start + size, text.length)
    chunks.push(text.slice(start, end))
    start = start + step
  }

  return chunks
}

export const makeCharacterChunker = (options: CharacterChunkerOptions): Chunker => ({
  chunk: document =>
    chunkText(document.text, options).map((text, index) => ({
      id: `${document.id}:chunk:${index}`,
      documentId: document.id,
      text,
      index,
      metadata: document.metadata
    }))
})
