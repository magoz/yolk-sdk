import { Effect } from 'effect'
import { buildKnowledgeContext } from '@yolk-sdk/knowledge/context'
import { KnowledgeStore } from '@yolk-sdk/knowledge/store'

const pinnedContextObjectLimit = 12
const pinnedContextMaxCharacters = 6000

export const getPinnedKnowledgeContext = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore
    const pinned = yield* store.listPinned({
      scope: { id: input.userId, kind: 'user' },
      limit: pinnedContextObjectLimit
    })

    return buildKnowledgeContext({
      documents: pinned.documents,
      maxCharacters: pinnedContextMaxCharacters
    })
  }).pipe(Effect.withSpan('knowledge.getPinnedKnowledgeContext'))
