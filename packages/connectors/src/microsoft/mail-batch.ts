import { Data, Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { microsoftGraphApiBaseUrl } from './shared.ts'

/**
 * Microsoft Graph JSON batching mechanics for Outlook batch message actions.
 *
 * Action definitions, mailbox permission selection, and result classification
 * stay in `mail.ts`; this module owns only envelope construction, chunk
 * correlation, and envelope decoding. It never authorizes operations itself:
 * callers pass an already-resolved operation token.
 */

export const graphBatchMaxRequests = 20

const graphBatchImmutableIdPreference = 'IdType="ImmutableId"'

export type GraphBatchSubrequest = {
  readonly key: string
  readonly method: 'GET' | 'PATCH' | 'POST' | 'DELETE'
  /** Root-relative URL under v1.0, e.g. `/me/messages/{id}`. */
  readonly url: string
  readonly body?: unknown
}

export type GraphBatchItemResponse = {
  readonly _tag: 'Response'
  readonly key: string
  readonly status: number
  /** Decoded subresponse body; `undefined` when absent (e.g. 204). */
  readonly body: unknown
}

export type GraphBatchResponseEntry =
  | GraphBatchItemResponse
  | { readonly _tag: 'Invalid'; readonly key: string }

const { Response, Invalid } = Data.taggedEnum<GraphBatchResponseEntry>()

export type GraphBatchChunkOutcome =
  | {
      readonly _tag: 'Executed'
      readonly items: ReadonlyArray<GraphBatchResponseEntry>
      /** At least one subresponse could not be decoded or correlated safely. */
      readonly integrityBroken: boolean
    }
  /** The envelope was definitively rejected before subrequest execution. */
  | { readonly _tag: 'Rejected'; readonly status: number }
  /** Transport failure, server failure, throttling, or malformed envelope. */
  | { readonly _tag: 'Ambiguous' }

const { Executed, Rejected, Ambiguous } = Data.taggedEnum<GraphBatchChunkOutcome>()

const GraphBatchResponseStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))

const GraphBatchResponseItem = Schema.Struct({
  id: Schema.String,
  status: GraphBatchResponseStatus,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Unknown)
})

const GraphBatchResponseIdentity = Schema.Struct({ id: Schema.String })

// Decode the envelope independently from its entries so one malformed
// subresponse cannot erase valid, correlated sibling outcomes.
const GraphBatchEnvelope = Schema.Struct({
  responses: Schema.optional(Schema.Array(Schema.Unknown))
})

/** Split requested IDs into sequential Graph envelopes of at most 20. */
export const toGraphBatchChunks = (
  messageIds: ReadonlyArray<string>
): Array<ReadonlyArray<string>> => {
  const chunks: Array<ReadonlyArray<string>> = []

  for (let index = 0; index < messageIds.length; index += graphBatchMaxRequests) {
    chunks.push(messageIds.slice(index, index + graphBatchMaxRequests))
  }

  return chunks
}

const graphBatchSubrequestBody = (subrequest: GraphBatchSubrequest) => {
  const headers: Record<string, string> =
    subrequest.body === undefined
      ? { Prefer: graphBatchImmutableIdPreference }
      : { Prefer: graphBatchImmutableIdPreference, 'Content-Type': 'application/json' }

  const base = {
    id: subrequest.key,
    method: subrequest.method,
    url: subrequest.url,
    headers
  }

  if (subrequest.body === undefined) return base

  return { ...base, body: subrequest.body }
}

/**
 * Execute one envelope of at most 20 subrequests. Responses are matched by
 * correlation ID, never position. The outer status never establishes item
 * success. Only `ConnectorHttpClient` is required; transport failures become
 * `Ambiguous` rather than Effect failures so earlier chunk outcomes survive.
 */
export const executeGraphBatch = (input: {
  readonly token: string
  readonly subrequests: ReadonlyArray<GraphBatchSubrequest>
}): Effect.Effect<GraphBatchChunkOutcome, never, ConnectorHttpClient> =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient

    const response = yield* Effect.catch(
      http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}/$batch`,
          headers: {
            authorization: `Bearer ${input.token}`,
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({ requests: input.subrequests.map(graphBatchSubrequestBody) })
        })
      ),
      () => Effect.succeed(undefined)
    )

    if (response === undefined) return Ambiguous()

    const envelope = yield* decodeJsonResponse(GraphBatchEnvelope, response).pipe(Effect.result)

    if (response.status >= 200 && response.status < 300 && Result.isSuccess(envelope)) {
      const requestedKeys = new Set(input.subrequests.map(subrequest => subrequest.key))
      const items: Array<GraphBatchResponseEntry> = []
      let integrityBroken = false

      for (const rawItem of envelope.success.responses ?? []) {
        const item = yield* Schema.decodeUnknownEffect(GraphBatchResponseItem)(rawItem).pipe(
          Effect.result
        )

        if (Result.isSuccess(item)) {
          items.push(
            Response({
              key: item.success.id,
              status: item.success.status,
              body: item.success.body
            })
          )

          if (!requestedKeys.has(item.success.id)) integrityBroken = true
          continue
        }

        integrityBroken = true

        const identity = yield* Schema.decodeUnknownEffect(GraphBatchResponseIdentity)(
          rawItem
        ).pipe(Effect.result)

        if (Result.isSuccess(identity)) {
          items.push(Invalid({ key: identity.success.id }))
        }
      }

      return Executed({ items, integrityBroken })
    }

    // A definitive envelope rejection means its mutations were not attempted.
    // Timeouts, throttling, server failures, and malformed envelopes stay
    // ambiguous for the submitted chunk because execution cannot be ruled out.
    if (
      response.status !== 408 &&
      response.status !== 429 &&
      response.status >= 400 &&
      response.status < 500
    ) {
      return Rejected({ status: response.status })
    }

    return Ambiguous()
  })
