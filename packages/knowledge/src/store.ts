import { Context } from 'effect'
import type { Effect } from 'effect'
import type { KnowledgeArtifact } from './artifacts.ts'
import type { KnowledgeStoreError } from './errors.ts'
import type { KnowledgeLink } from './links.ts'
import type {
  CreateKnowledgeObjectInput,
  KnowledgeObject,
  KnowledgeScope,
  UpdateKnowledgeObjectInput
} from './objects.ts'
import type { KnowledgeProvenance } from './provenance.ts'
import type { KnowledgeRepresentation } from './representations.ts'

export type GetKnowledgeObjectInput = {
  readonly scope: KnowledgeScope
  readonly id: string
}

export type ListKnowledgeObjectsInput = {
  readonly scope: KnowledgeScope
  readonly limit: number
}

export type ListKnowledgeObjectsResult = {
  readonly objects: ReadonlyArray<KnowledgeObject>
}

export type ListPinnedKnowledgeInput = {
  readonly scope: KnowledgeScope
  readonly limit: number
}

export type ListPinnedKnowledgeResult = {
  readonly objects: ReadonlyArray<KnowledgeObject>
  readonly representations: ReadonlyArray<KnowledgeRepresentation>
}

export type KnowledgeStoreApi = {
  readonly createObject: (input: CreateKnowledgeObjectInput) => Effect.Effect<KnowledgeObject, KnowledgeStoreError>
  readonly updateObject: (input: UpdateKnowledgeObjectInput) => Effect.Effect<KnowledgeObject, KnowledgeStoreError>
  readonly getObject: (input: GetKnowledgeObjectInput) => Effect.Effect<KnowledgeObject, KnowledgeStoreError>
  readonly listObjects: (input: ListKnowledgeObjectsInput) => Effect.Effect<ListKnowledgeObjectsResult, KnowledgeStoreError>
  readonly listPinned: (input: ListPinnedKnowledgeInput) => Effect.Effect<ListPinnedKnowledgeResult, KnowledgeStoreError>
  readonly deleteObject: (input: GetKnowledgeObjectInput) => Effect.Effect<void, KnowledgeStoreError>
  readonly listArtifacts: (input: GetKnowledgeObjectInput) => Effect.Effect<ReadonlyArray<KnowledgeArtifact>, KnowledgeStoreError>
  readonly listProvenance: (input: GetKnowledgeObjectInput) => Effect.Effect<ReadonlyArray<KnowledgeProvenance>, KnowledgeStoreError>
  readonly listLinks: (input: GetKnowledgeObjectInput) => Effect.Effect<ReadonlyArray<KnowledgeLink>, KnowledgeStoreError>
}

export class KnowledgeStore extends Context.Service<KnowledgeStore, KnowledgeStoreApi>()(
  '@yolk-sdk/knowledge/KnowledgeStore'
) {}
