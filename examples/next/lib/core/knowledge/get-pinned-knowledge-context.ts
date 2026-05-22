import { Effect } from 'effect'
import { buildKnowledgeContext, type KnowledgeContextItem } from '@yolk-sdk/knowledge/context'
import { KnowledgeStore } from '@yolk-sdk/knowledge/store'
import type { KnowledgeRecord } from '@yolk-sdk/knowledge/records'
import type { KnowledgeRepresentation } from '@yolk-sdk/knowledge/representations'

const pinnedContextObjectLimit = 12
const pinnedContextMaxCharacters = 6000

const itemForRecord = (input: {
  readonly record: KnowledgeRecord
  readonly representations: ReadonlyArray<KnowledgeRepresentation>
}): KnowledgeContextItem => {
  const representation = input.representations.find(item => item.recordId === input.record.id)
  return representation === undefined ? { record: input.record } : { record: input.record, representation }
}

export const getPinnedKnowledgeContext = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore
    const pinned = yield* store.listPinned({
      scope: { id: input.userId, kind: 'user' },
      limit: pinnedContextObjectLimit
    })

    return buildKnowledgeContext({
      items: pinned.records.map(record => itemForRecord({ record, representations: pinned.representations })),
      maxCharacters: pinnedContextMaxCharacters
    })
  }).pipe(Effect.withSpan('knowledge.getPinnedKnowledgeContext'))
