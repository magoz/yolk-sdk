import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentWebSocketClientMessage,
  HitlRequest,
  HitlResponse,
  InputDescriptor,
  InputRequest,
  InputResponse,
  InputResponseInput,
  ToolCall,
  ToolDef,
  formatInputResponseContent,
  hitlResponseEvent,
  inputRequestId,
  inputResponseStructuredContent,
  plainHitlResponse,
  plainInputResponse
} from '@yolk-sdk/agent/protocol'

const call = ToolCall.make({ id: 'call_1', name: 'contact', params: {} })

const descriptor = InputDescriptor.make({
  kind: 'custom',
  title: 'Contact',
  description: 'Collect contact details.',
  schema: {
    type: 'object',
    properties: { email: { type: 'string' } },
    required: ['email'],
    additionalProperties: false
  }
})

const request = InputRequest.make({
  requestId: inputRequestId(call),
  toolCallId: call.id,
  call,
  input: descriptor
})

const submitted = InputResponse.make({
  requestId: inputRequestId(call),
  toolCallId: call.id,
  outcome: 'submitted',
  source: 'user',
  data: { email: 'a@example.com' }
})

const encodeHitlResponse = Schema.encodeEffect(Schema.fromJsonString(HitlResponse))

const decodeHitlResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(HitlResponse))

const encodeHitlRequest = Schema.encodeEffect(HitlRequest)

const decodeHitlRequest = Schema.decodeUnknownEffect(HitlRequest)

const encodeToolDef = Schema.encodeEffect(ToolDef)

const decodeToolDef = Schema.decodeUnknownEffect(ToolDef)

const decodeInputResponse = Schema.decodeUnknownEffect(InputResponse)

const encodeClientMessage = Schema.encodeEffect(AgentWebSocketClientMessage)

const decodeClientMessage = Schema.decodeUnknownEffect(AgentWebSocketClientMessage)

describe('typed input protocol', () => {
  it('binds stable request/call correlation distinct from question ids', () => {
    expect(inputRequestId(call)).toBe('input:contact:call_1')

    expect(request.requestId).toBe('input:contact:call_1')

    expect(request.toolCallId).toBe(call.id)
  })

  it.effect('round-trips input requests and responses through the HITL unions', () =>
    Effect.gen(function* () {
      const encodedRequest = yield* encodeHitlRequest(request)

      const decodedRequest = yield* decodeHitlRequest(encodedRequest)

      expect(decodedRequest._tag).toBe('InputRequest')

      const encodedResponse = yield* Schema.encodeEffect(HitlResponse)(submitted)

      const decodedResponse = yield* Schema.decodeUnknownEffect(HitlResponse)(encodedResponse)

      expect(decodedResponse._tag).toBe('InputResponse')

      expect(decodedResponse).toEqual(submitted)
    })
  )

  it.effect('serializes HITL payloads as plain JSON strings', () =>
    Effect.gen(function* () {
      const encoded = yield* encodeHitlResponse(submitted)

      const reparsed = yield* decodeHitlResponse(encoded)

      expect(reparsed).toEqual(submitted)

      expect(JSON.parse(encoded)).toEqual(JSON.parse(JSON.stringify(submitted)))
    })
  )

  it.effect('rejects non-JSON user payloads', () =>
    Effect.gen(function* () {
      const invalid = {
        requestId: inputRequestId(call),
        toolCallId: call.id,
        outcome: 'submitted',
        source: 'user',
        data: Number.NaN
      }

      const result = yield* decodeInputResponse(invalid).pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)
    })
  )

  it.effect('keeps tool definitions serializable with a display-only descriptor', () =>
    Effect.gen(function* () {
      const def = ToolDef.make({
        name: 'contact',
        description: 'Collect contact details.',
        parameters: {},
        input: descriptor
      })

      const encoded = yield* encodeToolDef(def)

      const roundTripped = yield* decodeToolDef(encoded)

      expect(roundTripped).toEqual(def)

      expect(roundTripped.input?.kind).toBe('custom')

      expect(def.approval).toBeUndefined()

      expect(def.background).toBeUndefined()

      expect(def.execution).toBeUndefined()
    })
  )

  it('exposes plain durable payloads without class instances', () => {
    const plain = plainInputResponse(submitted)

    expect(plain._tag).toBe('InputResponse')

    expect(plain).toEqual(JSON.parse(JSON.stringify(plain)))

    expect(plainHitlResponse(submitted)).toEqual(plain)
  })

  it('projects structured content and model-visible text', () => {
    expect(inputResponseStructuredContent(submitted, 'contact')).toEqual({
      type: 'input_response',
      name: 'contact',
      outcome: 'submitted',
      data: { email: 'a@example.com' },
      source: 'user'
    })

    expect(formatInputResponseContent(submitted, 'contact')).toBe(
      'User has provided input for "contact": {"email":"a@example.com"}. Continue with the user\'s input in mind.'
    )

    const cancelled = InputResponse.make({
      requestId: inputRequestId(call),
      toolCallId: call.id,
      outcome: 'cancelled',
      source: 'user',
      reason: 'not now'
    })

    expect(formatInputResponseContent(cancelled, 'contact')).toBe('Input cancelled: not now')

    expect(inputResponseStructuredContent(cancelled, 'contact').outcome).toBe('cancelled')
  })

  it('maps responses to submitted/cancelled events', () => {
    expect(hitlResponseEvent(submitted)._tag).toBe('InputSubmitted')

    const cancelled = InputResponse.make({
      requestId: inputRequestId(call),
      toolCallId: call.id,
      outcome: 'cancelled',
      source: 'user'
    })

    expect(hitlResponseEvent(cancelled)._tag).toBe('InputCancelled')
  })

  it.effect('routes input responses through the WebSocket control input', () =>
    Effect.gen(function* () {
      const control = InputResponseInput.make({ response: submitted, expectedRevision: 3 })

      const encoded = yield* encodeClientMessage(control)

      const decoded = yield* decodeClientMessage(encoded)

      expect(decoded._tag).toBe('InputResponseInput')
    })
  )
})
