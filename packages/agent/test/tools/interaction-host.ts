import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  InteractionClaim,
  InteractionRequest,
  InteractionHostError,
  InteractionReceipt,
  ToolResult,
  ToolCall,
  validateInteractionSubmission,
  interactionJsonEquals,
  validInteractionReceipt,
  type InteractionHost,
  type InteractionAdmissionError,
  type InteractionOutcome,
  type InteractionPreflight,
  type InteractionRef,
  InteractionResponse
} from '@yolk-sdk/agent/protocol'

const snapshot = (receipt: InteractionReceipt) =>
  Schema.decodeUnknownEffect(InteractionReceipt)(structuredClone(receipt)).pipe(Effect.orDie)

const snapshotOutcome = (outcome: InteractionOutcome) =>
  Schema.decodeUnknownEffect(ToolResult)(structuredClone(outcome.result)).pipe(
    Effect.map(result => ({ status: outcome.status, result })),
    Effect.orDie
  )

/** Reference only: a scoped, authenticated fake-effect document host, not SDK storage.
 * Acceptance is separate from claim and all actions compete for one pending slot. */
export const makeFakeInteractionHost = (
  options: {
    readonly scope?: string
    readonly settlement?: 'fail' | 'lose-ack'
  } = {}
) => {
  const scope = options.scope ?? 'session/run/generation'
  const pending = new Map<string, { request: InteractionRequest; owner: string }>()

  const records = new Map<
    string,
    { receipt: InteractionReceipt; token?: string; outcome?: InteractionOutcome }
  >()

  let sequence = 0
  let reads = 0
  let claims = 0
  let settlements = 0
  let accepted = 0
  let loseAck = options.settlement === 'lose-ack'

  const error = (cause: InteractionHostError['cause']) =>
    new InteractionHostError({ cause, message: cause })

  const host: InteractionHost = {
    read: slot =>
      Effect.gen(function* () {
        reads += 1
        const receipt = records.get(slot)?.receipt

        return receipt === undefined ? undefined : yield* snapshot(receipt)
      }),
    claim: ref =>
      Effect.gen(function* () {
        claims += 1
        const stored = records.get(ref.slot)

        if (stored === undefined) return yield* Effect.fail(error('not_found'))

        if (stored.receipt.submissionId !== ref.submissionId)
          return yield* Effect.fail(error('conflict'))

        if (stored.receipt.status !== 'accepted')
          return InteractionClaim.Existing({ receipt: yield* snapshot(stored.receipt) })
        const token = `${scope}/token/${++sequence}`
        const receipt = InteractionReceipt.make({ ...stored.receipt, status: 'started' })
        records.set(ref.slot, { receipt, token })

        return InteractionClaim.Owned({ token, receipt: yield* snapshot(receipt) })
      }),
    settle: (token, outcome) =>
      Effect.gen(function* () {
        settlements += 1

        if (options.settlement === 'fail') return yield* Effect.fail(error('storage'))

        for (const [slot, stored] of records) {
          if (stored.token !== token) continue

          if (stored.outcome !== undefined) return yield* snapshotOutcome(stored.outcome)

          if (
            !validInteractionReceipt(
              { ...stored.receipt, status: 'settled', result: outcome.result },
              stored.receipt.call
            ) ||
            !Schema.is(Schema.Record(Schema.String, Schema.Unknown))(
              outcome.result.structuredContent
            ) ||
            outcome.result.structuredContent.outcome !== outcome.status
          ) {
            return yield* Effect.fail(error('denied'))
          }

          const authoritative = yield* snapshotOutcome(outcome)

          const receipt = InteractionReceipt.make({
            ...stored.receipt,
            status: 'settled',
            result: authoritative.result
          })

          records.set(slot, { ...stored, receipt, outcome: authoritative })

          if (loseAck) {
            loseAck = false

            return yield* Effect.fail(error('storage'))
          }

          return yield* snapshotOutcome(authoritative)
        }

        return yield* Effect.fail(error('denied'))
      })
  }

  const accept = (
    rawResponse: InteractionResponse,
    interaction: InteractionPreflight,
    actor = 'user',
    activeScope = scope
  ): Effect.Effect<InteractionRef, InteractionHostError | InteractionAdmissionError> =>
    Effect.gen(function* () {
      // Copy browser values before validation; later edits cannot change acceptance.
      const response = yield* Schema.decodeUnknownEffect(InteractionResponse)(
        structuredClone(rawResponse)
      ).pipe(Effect.orDie)

      // This is the authenticated host boundary, before SDK resume/claim.
      const entry = pending.get(response.requestId)

      if (activeScope !== scope || entry === undefined || entry.owner !== actor)
        return yield* Effect.fail(error('denied'))

      const candidate = yield* validateInteractionSubmission({
        request: entry.request,
        response,
        ...interaction
      })

      const stored = records.get(candidate.slot)

      if (stored !== undefined) {
        if (
          stored.receipt.outcome !== response.outcome ||
          stored.receipt.actionId !== response.actionId ||
          stored.receipt.reason !== response.reason ||
          (stored.receipt.data === undefined
            ? response.data !== undefined
            : !interactionJsonEquals(stored.receipt.data, response.data))
        ) {
          return yield* Effect.fail(error('conflict'))
        }

        return { slot: stored.receipt.slot, submissionId: stored.receipt.submissionId }
      }

      accepted += 1
      const ref = { slot: candidate.slot, submissionId: `${scope}/submission/${++sequence}` }

      const result =
        response.outcome === 'cancelled'
          ? ToolResult.make({
              toolCallId: entry.request.call.id,
              content: `Interaction cancelled: ${response.reason ?? 'cancelled'}`,
              isError: true,
              structuredContent: {
                type: 'interaction_outcome',
                requestId: ref.slot,
                ...ref,
                outcome: 'cancelled'
              }
            })
          : undefined

      records.set(candidate.slot, {
        receipt: InteractionReceipt.make({
          ...ref,
          call: entry.request.call,
          outcome: response.outcome,
          actionId: response.actionId,
          data: response.data,
          reason: response.reason,
          status: response.outcome === 'cancelled' ? 'settled' : 'accepted',
          result
        })
      })

      return ref
    })

  return {
    host,
    accept,
    addPending: (request: InteractionRequest, owner = 'user') =>
      pending.set(request.requestId, {
        request: InteractionRequest.make({
          ...request,
          call: ToolCall.make({ ...request.call, params: structuredClone(request.call.params) })
        }),
        owner
      }),
    counts: () => ({ reads, claims, settlements, accepted }),
    receiptFor: (slot: string) => structuredClone(records.get(slot)?.receipt)
  }
}
