import { Effect } from 'effect'
import { buildKnowledgeContext, type KnowledgeContextItem } from '@yolk/knowledge/context'
import { KnowledgeStore } from '@yolk/knowledge/store'
import type { KnowledgeObject } from '@yolk/knowledge/objects'
import type { KnowledgeRepresentation } from '@yolk/knowledge/representations'

const pinnedContextObjectLimit = 12
const pinnedContextMaxCharacters = 6000

const itemForObject = (input: {
  readonly object: KnowledgeObject
  readonly representations: ReadonlyArray<KnowledgeRepresentation>
}): KnowledgeContextItem => {
  const representation = input.representations.find(item => item.objectId === input.object.id)
  return representation === undefined ? { object: input.object } : { object: input.object, representation }
}

export const getPinnedKnowledgeContext = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore
    const pinned = yield* store.listPinned({
      scope: { id: input.userId, kind: 'user' },
      limit: pinnedContextObjectLimit
    })

    return buildKnowledgeContext({
      items: pinned.objects.map(object => itemForObject({ object, representations: pinned.representations })),
      maxCharacters: pinnedContextMaxCharacters
    })
  }).pipe(Effect.withSpan('knowledge.getPinnedKnowledgeContext'))
