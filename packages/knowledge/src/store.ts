import { Context } from 'effect'
import type { Effect } from 'effect'
import type { KnowledgeArtifact } from './artifacts.ts'
import type { KnowledgeStoreError } from './errors.ts'
import type { KnowledgeLink } from './links.ts'
import type {
  CreateKnowledgeRecordInput,
  KnowledgeRecord,
  KnowledgeScope,
  UpdateKnowledgeRecordInput
} from './records.ts'
import type { KnowledgeProvenance } from './provenance.ts'
import type { KnowledgeRepresentation } from './representations.ts'

export type GetKnowledgeRecordInput = {
  readonly scope: KnowledgeScope
  readonly id: string
}

export type ListKnowledgeRecordsInput = {
  readonly scope: KnowledgeScope
  readonly limit: number
}

export type ListKnowledgeRecordsResult = {
  readonly records: ReadonlyArray<KnowledgeRecord>
}

export type ListPinnedKnowledgeInput = {
  readonly scope: KnowledgeScope
  readonly limit: number
}

export type ListPinnedKnowledgeResult = {
  readonly records: ReadonlyArray<KnowledgeRecord>
  readonly representations: ReadonlyArray<KnowledgeRepresentation>
}

export type KnowledgeStoreApi = {
  readonly createRecord: (input: CreateKnowledgeRecordInput) => Effect.Effect<KnowledgeRecord, KnowledgeStoreError>
  readonly updateRecord: (input: UpdateKnowledgeRecordInput) => Effect.Effect<KnowledgeRecord, KnowledgeStoreError>
  readonly getRecord: (input: GetKnowledgeRecordInput) => Effect.Effect<KnowledgeRecord, KnowledgeStoreError>
  readonly listRecords: (input: ListKnowledgeRecordsInput) => Effect.Effect<ListKnowledgeRecordsResult, KnowledgeStoreError>
  readonly listPinned: (input: ListPinnedKnowledgeInput) => Effect.Effect<ListPinnedKnowledgeResult, KnowledgeStoreError>
  readonly deleteRecord: (input: GetKnowledgeRecordInput) => Effect.Effect<void, KnowledgeStoreError>
  readonly listArtifacts: (input: GetKnowledgeRecordInput) => Effect.Effect<ReadonlyArray<KnowledgeArtifact>, KnowledgeStoreError>
  readonly listProvenance: (input: GetKnowledgeRecordInput) => Effect.Effect<ReadonlyArray<KnowledgeProvenance>, KnowledgeStoreError>
  readonly listLinks: (input: GetKnowledgeRecordInput) => Effect.Effect<ReadonlyArray<KnowledgeLink>, KnowledgeStoreError>
}

export class KnowledgeStore extends Context.Service<KnowledgeStore, KnowledgeStoreApi>()(
  '@yolk-sdk/knowledge/KnowledgeStore'
) {}
