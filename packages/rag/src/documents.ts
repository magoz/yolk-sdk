export type RagMetadata = Readonly<Record<string, string>>

export type RagDocument = {
  readonly id: string
  readonly text: string
  readonly metadata: RagMetadata
}

export type RagChunk = {
  readonly id: string
  readonly documentId: string
  readonly text: string
  readonly index: number
  readonly metadata: RagMetadata
}

export const makeRagDocument = (input: {
  readonly id: string
  readonly text: string
  readonly metadata?: RagMetadata
}): RagDocument => ({
  id: input.id,
  text: input.text,
  metadata: input.metadata ?? {}
})
