/**
 * The default chunker's tokenizer-backed half: `gpt-tokenizer`'s `o200k_base` encoding (about
 * 2 MB of rank tables, evaluated on import) and the splitting that needs token counts.
 *
 * Not a public subpath. Only `chunking.ts` loads it, and only with a dynamic `import()` when text
 * is first chunked or counted, so importing the chunker contract or providing
 * `DefaultKnowledgeChunkerLive` never evaluates the tokenizer. Never import it statically.
 */
import { countTokens, decode, encode } from 'gpt-tokenizer/encoding/o200k_base'

const SENTENCE_PATTERN = /[^.!?]+[.!?]+(?:["')\]]+)?\s*|[^.!?]+$/g

const PARAGRAPH_BREAK_PATTERN = /(\n{2,})/

const WORD_PATTERN = /\S+\s*/g

export { countTokens }

export type TokenizedChunk = {
  readonly content: string
  readonly tokenCount: number
}

const splitSentences = (text: string) =>
  text
    .split(PARAGRAPH_BREAK_PATTERN)
    .flatMap(part => {
      if (part.length === 0) {
        return []
      }

      if (/^\n{2,}$/.test(part)) {
        return ['\n\n']
      }

      return part.match(SENTENCE_PATTERN) ?? [part]
    })
    .filter(unit => unit.length > 0)

// Pieces of an oversized unit keep their whitespace: `buildChunkContents` joins pieces that fit
// one chunk as they are, so trimming here would glue words and sentences together. It trims each
// chunk's edges instead.
const splitEncodedTokens = (text: string, maxTokens: number) => {
  const tokens = encode(text)

  return Array.from({ length: Math.ceil(tokens.length / maxTokens) }, (_, index) =>
    decode(tokens.slice(index * maxTokens, index * maxTokens + maxTokens))
  ).filter(piece => piece.length > 0)
}

const splitOversizedUnit = (text: string, maxTokens: number) => {
  const words = text.match(WORD_PATTERN) ?? []
  const pieces: string[] = []
  let current = ''
  let currentTokenCount = 0

  const pushCurrent = () => {
    if (current.length > 0) {
      pieces.push(current)
    }
  }

  for (const word of words) {
    const wordTokenCount = countTokens(word)

    if (wordTokenCount > maxTokens) {
      pushCurrent()
      pieces.push(...splitEncodedTokens(word, maxTokens))
      current = ''
      currentTokenCount = 0
      continue
    }

    if (currentTokenCount > 0 && currentTokenCount + wordTokenCount > maxTokens) {
      pushCurrent()
      current = word
      currentTokenCount = wordTokenCount
      continue
    }

    current = `${current}${word}`
    currentTokenCount += wordTokenCount
  }

  pushCurrent()

  return pieces
}

const splitUnitsBySize = (units: ReadonlyArray<string>, maxTokens: number) =>
  units.flatMap(unit =>
    countTokens(unit) <= maxTokens ? [unit] : splitOversizedUnit(unit, maxTokens)
  )

const buildChunkContents = (units: ReadonlyArray<string>, maxTokens: number) => {
  const chunks: string[] = []
  let current = ''
  let currentTokenCount = 0

  const pushCurrent = () => {
    const content = current.trim()

    if (content.length > 0) {
      chunks.push(content)
    }
  }

  for (const unit of units) {
    const unitTokenCount = countTokens(unit)

    if (currentTokenCount > 0 && currentTokenCount + unitTokenCount > maxTokens) {
      pushCurrent()
      current = unit
      currentTokenCount = unitTokenCount
      continue
    }

    current = `${current}${unit}`
    currentTokenCount += unitTokenCount
  }

  pushCurrent()

  return chunks
}

/**
 * Splits sanitized, non-empty text at paragraph and sentence boundaries into chunks of at most
 * `maxTokens` tokens (a positive integer), splitting oversized sentences by words and oversized
 * words by tokens.
 */
export const chunkText = (text: string, maxTokens: number): ReadonlyArray<TokenizedChunk> =>
  buildChunkContents(splitUnitsBySize(splitSentences(text), maxTokens), maxTokens).map(content => ({
    content,
    tokenCount: countTokens(content)
  }))
