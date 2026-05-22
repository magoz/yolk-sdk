import { Context } from 'effect'
import type { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { KnowledgeArtifactError } from './errors.ts'
import { KnowledgeMetadataSchema, NonEmptyTrimmedString, NonNegativeInteger } from './records.ts'

export const KnowledgeArtifactKindSchema = Schema.Literals([
  'original',
  'extracted_text',
  'thumbnail',
  'transcript',
  'caption',
  'structured'
])
export type KnowledgeArtifactKind = Schema.Schema.Type<typeof KnowledgeArtifactKindSchema>

export const KnowledgeArtifactSchema = Schema.Struct({
  id: NonEmptyTrimmedString,
  recordId: NonEmptyTrimmedString,
  kind: KnowledgeArtifactKindSchema,
  storageKey: NonEmptyTrimmedString,
  mediaType: Schema.optional(NonEmptyTrimmedString),
  byteSize: Schema.optional(NonNegativeInteger),
  checksum: Schema.optional(NonEmptyTrimmedString),
  metadata: Schema.optional(KnowledgeMetadataSchema),
  createdAt: Schema.DateTimeUtc
})
export type KnowledgeArtifact = Schema.Schema.Type<typeof KnowledgeArtifactSchema>

export type PutKnowledgeArtifactInput = {
  readonly storageKey: string
  readonly mediaType?: string
  readonly bytes: Uint8Array
}

export type GetKnowledgeArtifactInput = {
  readonly storageKey: string
}

export type KnowledgeArtifactStoreApi = {
  readonly putArtifact: (input: PutKnowledgeArtifactInput) => Effect.Effect<void, KnowledgeArtifactError>
  readonly getArtifact: (input: GetKnowledgeArtifactInput) => Effect.Effect<Uint8Array, KnowledgeArtifactError>
  readonly deleteArtifact: (input: GetKnowledgeArtifactInput) => Effect.Effect<void, KnowledgeArtifactError>
}

export class KnowledgeArtifactStore extends Context.Service<KnowledgeArtifactStore, KnowledgeArtifactStoreApi>()(
  '@yolk-sdk/knowledge/KnowledgeArtifactStore'
) {}
