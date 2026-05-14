import type { Effect } from 'effect'

export type Embedding = ReadonlyArray<number>

export class EmbedderError extends Error {
  readonly _tag = 'EmbedderError'
}

export type Embedder = {
  readonly embed: (input: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Embedding>, EmbedderError>
}
