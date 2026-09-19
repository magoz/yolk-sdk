import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  HitlRequest,
  HitlResponse,
  InteractionDescriptor,
  InteractionRequest,
  InteractionResponse,
  ToolCall,
  hitlResponseEvent,
  interactionRequestId,
  interactionUnknownOutcomeNotice,
  makeInteractionToolResult,
  plainHitlResponse,
  validateInteractionSubmission
} from '../../src/protocol/index.ts'

import { interactionJsonEquals } from '../../src/protocol/tool.ts'

const call = ToolCall.make({ id: 'call_1', name: 'release', params: { channel: 'stable' } })

const Draft = Schema.Struct({
  title: Schema.String,
  notes: Schema.optional(Schema.String)
})

const StrictDraft = Schema.Struct({
  title: Schema.String
})

const validateCall = (params: unknown) =>
  Schema.decodeUnknownEffect(Schema.Struct({ channel: Schema.String }), {
    onExcessProperty: 'error'
  })(params).pipe(Effect.asVoid)

const validateResponse = (data: unknown) =>
  Schema.decodeUnknownEffect(Draft, { onExcessProperty: 'error' })(data).pipe(Effect.asVoid)

const interactionDescriptor = InteractionDescriptor.make({
  kind: 'release-editor',
  actions: [{ id: 'publish', label: 'Publish' }]
})

const request = InteractionRequest.make({
  requestId: interactionRequestId(call),
  toolCallId: call.id,
  call,
  interaction: interactionDescriptor
})

const submitted = (overrides: Partial<typeof InteractionResponse.Type> = {}) =>
  InteractionResponse.make({
    requestId: request.requestId,
    toolCallId: call.id,
    outcome: 'submitted',
    source: 'user',
    actionId: 'publish',
    data: { title: 'v2' },
    ...overrides
  })

const admit = (response: InteractionResponse, actionIds: ReadonlyArray<string> = ['publish']) =>
  validateInteractionSubmission({
    request,
    response,
    validateCall,
    validateResponse,
    actionIds,
    validateAction: () => Effect.void
  })

describe('interaction protocol', () => {
  it('uses a distinct request id namespace', () => {
    expect(interactionRequestId(call)).toBe('interaction:release:call_1')

    expect(request.requestId).toBe('interaction:release:call_1')
  })

  it.effect('round-trips requests and responses through plain JSON', () =>
    Effect.gen(function* () {
      const encodedRequest = yield* Schema.encodeUnknownEffect(HitlRequest)(request)

      const decodedRequest = yield* Schema.decodeUnknownEffect(HitlRequest)(
        JSON.parse(JSON.stringify(encodedRequest))
      )

      expect(Predicate.isTagged(decodedRequest, 'InteractionRequest')).toBe(true)

      for (const response of [
        submitted(),
        InteractionResponse.make({
          requestId: request.requestId,
          toolCallId: call.id,
          outcome: 'cancelled',
          source: 'user'
        })
      ]) {
        const encodedResponse = yield* Schema.encodeUnknownEffect(HitlResponse)(response)

        const decodedResponse = yield* Schema.decodeUnknownEffect(HitlResponse)(
          JSON.parse(JSON.stringify(encodedResponse))
        )

        expect(Predicate.isTagged(decodedResponse, 'InteractionResponse')).toBe(true)
        expect(plainHitlResponse(decodedResponse)).toEqual(plainHitlResponse(response))
      }
    })
  )

  it('maps submitted and cancelled responses to distinct events', () => {
    expect(hitlResponseEvent(submitted())._tag).toBe('InteractionSubmitted')

    expect(
      hitlResponseEvent(
        InteractionResponse.make({
          requestId: request.requestId,
          toolCallId: call.id,
          outcome: 'cancelled',
          source: 'user',
          reason: 'changed mind'
        })
      )._tag
    ).toBe('InteractionCancelled')
  })

  it.effect('admits a valid submission as a candidate, not authority', () =>
    Effect.gen(function* () {
      const candidate = yield* admit(submitted())

      expect(Predicate.isTagged(candidate, 'Submitted')).toBe(true)

      if (Predicate.isTagged(candidate, 'Submitted')) {
        expect(candidate.slot).toBe(request.requestId)

        expect(candidate.actionId).toBe('publish')

        expect(candidate.data).toEqual({ title: 'v2' })

        expect(candidate).not.toHaveProperty('submissionId')
      }
    })
  )

  it.effect('distinguishes absent data from valid null, false, and zero', () =>
    Effect.gen(function* () {
      const nullable = Schema.Struct({
        title: Schema.NullOr(Schema.String),
        flag: Schema.Boolean,
        count: Schema.Number
      })

      const admitNullable = (data: Schema.Json | undefined) => {
        const baseResponse = {
          requestId: request.requestId,
          toolCallId: call.id,
          outcome: 'submitted' as const,
          source: 'user' as const,
          actionId: 'publish'
        }

        const response =
          data === undefined
            ? InteractionResponse.make(baseResponse)
            : InteractionResponse.make({ ...baseResponse, data })

        return validateInteractionSubmission({
          request,
          response,
          validateCall,
          validateResponse: (input: unknown) =>
            Schema.decodeUnknownEffect(nullable, { onExcessProperty: 'error' })(input).pipe(
              Effect.asVoid
            ),
          actionIds: ['publish'],
          validateAction: () => Effect.void
        }).pipe(Effect.result)
      }

      const missing = yield* admitNullable(undefined)

      expect(missing._tag).toBe('Failure')

      for (const data of [{ title: null, flag: false, count: 0 }]) {
        const valid = yield* admitNullable(data)

        expect(valid._tag).toBe('Success')
      }
    })
  )

  it.effect('rejects excess fields, unknown actions, and mismatched correlation', () =>
    Effect.gen(function* () {
      const strictAdmit = (response: InteractionResponse) =>
        validateInteractionSubmission({
          request,
          response,
          validateCall,
          validateResponse: (input: unknown) =>
            Schema.decodeUnknownEffect(StrictDraft, { onExcessProperty: 'error' })(input).pipe(
              Effect.asVoid
            ),
          actionIds: ['publish'],
          validateAction: () => Effect.void
        }).pipe(Effect.flip)

      const excess = yield* strictAdmit(submitted({ data: { title: 'v2', extra: true } }))

      expect(excess.cause).toBe('invalid_data')

      const unknownAction = yield* strictAdmit(submitted({ actionId: 'delete' }))

      expect(unknownAction.cause).toBe('unknown_action')

      const missingAction = yield* strictAdmit(
        InteractionResponse.make({
          requestId: request.requestId,
          toolCallId: call.id,
          outcome: 'submitted',
          source: 'user',
          data: { title: 'v2' }
        })
      )

      expect(missingAction.cause).toBe('missing_action')

      const forged = yield* strictAdmit(submitted({ requestId: 'interaction:release:other' }))

      expect(forged.cause).toBe('request_mismatch')

      const staleCall = yield* strictAdmit(submitted({ toolCallId: 'call_2' }))

      expect(staleCall.cause).toBe('request_mismatch')
    })
  )

  it.effect('rejects cancellations that smuggle an action or data', () =>
    Effect.gen(function* () {
      const smuggled = yield* admit(
        InteractionResponse.make({
          requestId: request.requestId,
          toolCallId: call.id,
          outcome: 'cancelled',
          source: 'user',
          actionId: 'publish',
          data: { title: 'v2' }
        })
      ).pipe(Effect.flip)

      expect(smuggled.cause).toBe('cancelled_with_payload')

      const clean = yield* admit(
        InteractionResponse.make({
          requestId: request.requestId,
          toolCallId: call.id,
          outcome: 'cancelled',
          source: 'user'
        })
      )

      expect(Predicate.isTagged(clean, 'Cancelled')).toBe(true)
    })
  )

  it('compares full JSON without recommending payload identities', () => {
    expect(interactionJsonEquals({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true)
    expect(interactionJsonEquals({ nested: [1] }, { nested: [2] })).toBe(false)
    expect(interactionJsonEquals({ a: undefined }, {})).toBe(false)
  })

  it('shapes completed, failed, and unknown results distinctly', () => {
    const identity = {
      toolCallId: call.id,
      requestId: request.requestId,
      slot: request.requestId,
      submissionId: 'host-allocated-id',
      actionId: 'publish'
    }

    const completed = makeInteractionToolResult({
      ...identity,
      outcome: 'completed',
      content: 'Published v2.'
    })

    expect(completed.isError).toBeUndefined()

    expect(completed.structuredContent).toMatchObject({
      type: 'interaction_outcome',
      outcome: 'completed',
      slot: request.requestId,
      actionId: 'publish'
    })

    const failed = makeInteractionToolResult({
      ...identity,
      outcome: 'failed',
      content: 'Publish did not happen: quota exhausted.'
    })

    expect(failed.isError).toBe(true)

    expect(failed.structuredContent).toMatchObject({ outcome: 'failed' })

    const unknown = makeInteractionToolResult({
      ...identity,
      outcome: 'unknown',
      content: 'Publish request timed out.'
    })

    expect(unknown.isError).toBe(true)

    expect(unknown.content).toContain(interactionUnknownOutcomeNotice)

    expect(unknown.content).toContain('Publish request timed out.')

    expect(unknown.structuredContent).toMatchObject({
      outcome: 'unknown',
      submissionId: identity.submissionId
    })
  })
})
