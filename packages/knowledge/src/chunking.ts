import { Context, Effect, Layer } from 'effect'
import { countTokens, decode, encode } from 'gpt-tokenizer/encoding/o200k_base'
import type { KnowledgeChunk, KnowledgeMetadata } from './documents.ts'
import { KnowledgeChunkingError } from './errors.ts'

const SENTENCE_PATTERN = /[^.!?]+[.!?]+(?:["')\]]+)?\s*|[^.!?]+$/g
const PARAGRAPH_BREAK_PATTERN = /(\n{2,})/
const WORD_PATTERN = /\S+\s*/g

export type ChunkKnowledgeDocumentInput = {
  readonly scopeId: string
  readonly documentId: string
  readonly content: string
  readonly maxTokens?: number
  readonly metadata?: KnowledgeMetadata
}

export type KnowledgeChunkerApi = {
  readonly chunk: (
    input: ChunkKnowledgeDocumentInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeChunk>, KnowledgeChunkingError>
}

export class KnowledgeChunker extends Context.Service<KnowledgeChunker, KnowledgeChunkerApi>()(
  '@yolk-sdk/knowledge/KnowledgeChunker'
) {}

export const countKnowledgeChunkTokens = (text: string) => countTokens(text)

const sanitizeText = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

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

const splitEncodedTokens = (text: string, maxTokens: number) => {
  const tokens = encode(text)
  return Array.from({ length: Math.ceil(tokens.length / maxTokens) }, (_, index) =>
    decode(tokens.slice(index * maxTokens, index * maxTokens + maxTokens)).trim()
  ).filter(chunk => chunk.length > 0)
}

const splitOversizedUnit = (text: string, maxTokens: number) => {
  const words = text.match(WORD_PATTERN) ?? []
  const chunks: string[] = []
  let current = ''
  let currentTokenCount = 0

  for (const word of words) {
    const wordTokenCount = countTokens(word)

    if (wordTokenCount > maxTokens) {
      const currentChunk = current.trim()
      if (currentChunk.length > 0) {
        chunks.push(currentChunk)
      }

      chunks.push(...splitEncodedTokens(word, maxTokens))
      current = ''
      currentTokenCount = 0
      continue
    }

    if (currentTokenCount > 0 && currentTokenCount + wordTokenCount > maxTokens) {
      const currentChunk = current.trim()
      if (currentChunk.length > 0) {
        chunks.push(currentChunk)
      }

      current = word
      currentTokenCount = wordTokenCount
      continue
    }

    current = `${current}${word}`
    currentTokenCount += wordTokenCount
  }

  const finalChunk = current.trim()
  if (finalChunk.length > 0) {
    chunks.push(finalChunk)
  }

  return chunks
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

export const chunkKnowledgeText = (input: ChunkKnowledgeDocumentInput, maxTokens: number) =>
  Effect.gen(function* () {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      return yield* Effect.fail(
        new KnowledgeChunkingError({ message: 'Chunk maxTokens must be a positive integer' })
      )
    }

    const sanitized = sanitizeText(input.content)
    if (sanitized.length === 0) {
      return yield* Effect.fail(
        new KnowledgeChunkingError({ message: 'Cannot chunk empty content' })
      )
    }

    const units = splitUnitsBySize(splitSentences(sanitized), maxTokens)
    const contents = buildChunkContents(units, maxTokens)

    if (contents.length === 0) {
      return yield* Effect.fail(new KnowledgeChunkingError({ message: 'No chunks produced' }))
    }

    return contents.map((content, position) => ({
      id: `${input.documentId}:chunk:${position}`,
      scopeId: input.scopeId,
      documentId: input.documentId,
      content,
      position,
      tokenCount: countTokens(content),
      metadata: input.metadata
    })) satisfies ReadonlyArray<KnowledgeChunk>
  })

export const makeDefaultKnowledgeChunker = (input: {
  readonly maxTokens: number
}): KnowledgeChunkerApi => ({
  chunk: document => chunkKnowledgeText(document, document.maxTokens ?? input.maxTokens)
})

export const DefaultKnowledgeChunkerLive = (
  input: { readonly maxTokens: number } = { maxTokens: 512 }
) => Layer.succeed(KnowledgeChunker, makeDefaultKnowledgeChunker(input))
