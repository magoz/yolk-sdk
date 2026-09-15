import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { buildKnowledgeContext } from '@yolk-sdk/knowledge/context'
import { KnowledgeScopeId } from '@yolk-sdk/knowledge/documents'
import { KnowledgeStoreError } from '@yolk-sdk/knowledge/errors'
import { KnowledgeStore } from '@yolk-sdk/knowledge/store'

const pinnedContextObjectLimit = 12

const pinnedContextMaxCharacters = 6000

export const getPinnedKnowledgeContext = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore

    const scopeId = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)(input.userId).pipe(
      Effect.mapError(
        error => new KnowledgeStoreError({ message: 'Invalid knowledge scope id', cause: error })
      )
    )

    const pinned = yield* store.listPinned({
      scope: { id: scopeId, kind: 'user' },
      limit: pinnedContextObjectLimit
    })

    return buildKnowledgeContext({
      documents: pinned.documents,
      maxCharacters: pinnedContextMaxCharacters
    })
  }).pipe(Effect.withSpan('knowledge.getPinnedKnowledgeContext'))
