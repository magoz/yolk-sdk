/**
 * Form elicitation over MCP multi round-trip requests (`2026-07-28`) through the real
 * `@yolk-sdk/mcp/client` functions, against the official server SDK in-process (no network). The
 * fake server mirrors a confirmation-gated destructive tool: it requires `elicitation.form` in the
 * per-request client capabilities (else a `CLIENT_CAPABILITY_REQUIRED` tool error), answers the
 * first call with an `InputRequiredResult` (one form elicitation plus `requestState`), and acts
 * only on a retry that echoes the state with an accepted confirmation.
 */
import { Effect, Exit, Layer, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  callRemoteMcpServerTool,
  callRemoteMcpServerToolResumable,
  CLIENT_CAPABILITIES_META_KEY,
  listRemoteMcpServerTools,
  McpInputRequired,
  McpToolCallOutcome,
  resumeRemoteMcpServerToolCall,
  type McpClientOptions,
  type McpElicitationResponses,
  type McpRemoteServerConfig
} from '../../src/client'
import {
  createMcpHandler,
  inputRequired,
  inputResponse,
  McpServer,
  MissingRequiredClientCapabilityError,
  type ServerContext,
  type Tool
} from '../../src/server'

const config: McpRemoteServerConfig = {
  name: 'books',
  type: 'remote',
  url: 'https://mcp.example.test/mcp'
}

const optedIn: McpClientOptions = { elicitation: { form: true } }

const legacyOptions = (options: McpClientOptions): McpClientOptions => ({
  ...options,
  sdk: { versionNegotiation: { mode: 'legacy' } }
})

/** Shaped like Afloat's confirmation form: `const` and `additionalProperties` sit outside the spec subset. */
type ConfirmationSchema = {
  type: 'object'
  properties: { confirm: { type: 'boolean'; const: true; title: string } }
  required: Array<string>
  additionalProperties: false
}

const confirmationSchema: ConfirmationSchema = {
  type: 'object',
  properties: { confirm: { type: 'boolean', const: true, title: 'Delete it' } },
  required: ['confirm'],
  additionalProperties: false
}

const deleteTool: Tool = {
  name: 'delete_invoice',
  title: 'Delete invoice',
  description: 'Delete one invoice.',
  inputSchema: {
    type: 'object',
    properties: { invoiceId: { type: 'string' } },
    required: ['invoiceId']
  },
  outputSchema: {
    type: 'object',
    properties: { deleted: { type: 'boolean' } },
    required: ['deleted']
  },
  annotations: { destructiveHint: true }
}

const capabilityTool: Tool = {
  name: 'needs_capability',
  description: 'Refuses with MCP -32021.',
  inputSchema: { type: 'object' }
}

type ServerLedger = { minted: number; executed: number }

const FormElicitationEnvelope = Schema.Struct({
  [CLIENT_CAPABILITIES_META_KEY]: Schema.Struct({
    elicitation: Schema.Struct({ form: Schema.Record(Schema.String, Schema.Unknown) })
  })
})

const supportsFormElicitation = (context: ServerContext) =>
  Schema.is(FormElicitationEnvelope)(context.mcpReq.envelope)

const toolError = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

const makeConfirmingServer = (ledger: ServerLedger) => () => {
  const server = new McpServer({ name: 'confirming', version: '1.0.0' })

  server.server.registerCapabilities({ tools: { listChanged: false } })
  server.server.setRequestHandler('tools/list', () => ({ tools: [deleteTool, capabilityTool] }))
  server.server.setRequestHandler('tools/call', async (request, context) => {
    if (request.params.name === capabilityTool.name) {
      throw new MissingRequiredClientCapabilityError(
        { requiredCapabilities: { elicitation: { form: {} } } },
        'Form elicitation is required'
      )
    }

    if (!supportsFormElicitation(context)) {
      return toolError(
        JSON.stringify({
          error: {
            code: 'CLIENT_CAPABILITY_REQUIRED',
            message: 'Form elicitation support is required.'
          }
        })
      )
    }

    const state: unknown = context.mcpReq.requestState()

    if (state === undefined) {
      ledger.minted += 1

      return inputRequired({
        inputRequests: {
          confirmation: inputRequired.elicit({
            message: 'Delete invoice INV-1?',
            requestedSchema: confirmationSchema
          })
        },
        requestState: `opaque-state-${ledger.minted}`
      })
    }

    const response = inputResponse(context.mcpReq.inputResponses, 'confirmation')

    if (response.kind !== 'elicit') {
      return toolError('CONFIRMATION_REQUIRED')
    }

    if (response.action !== 'accept') {
      return toolError(`CONFIRMATION_${response.action.toUpperCase()}`)
    }

    ledger.executed += 1

    return {
      content: [{ type: 'text' as const, text: 'deleted' }],
      structuredContent: { deleted: true }
    }
  })

  return server
}

const WireMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})

type WireMessage = typeof WireMessage.Type

const decodeWireMessage = Schema.decodeUnknownOption(Schema.fromJsonString(WireMessage))

const MetaCapabilities = Schema.Struct({
  _meta: Schema.Struct({ [CLIENT_CAPABILITIES_META_KEY]: Schema.Unknown })
})

const InitializeParams = Schema.Struct({ capabilities: Schema.Unknown })

const RetryParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
  inputResponses: Schema.optional(Schema.Unknown),
  requestState: Schema.optional(Schema.Unknown)
})

const metaCapabilities = (message: WireMessage) =>
  Schema.decodeUnknownOption(MetaCapabilities)(message.params).pipe(
    Option.map(params => params._meta[CLIENT_CAPABILITIES_META_KEY]),
    Option.getOrUndefined
  )

const retryParams = (message: WireMessage) =>
  Option.getOrThrow(Schema.decodeUnknownOption(RetryParams)(message.params))

type Harness = {
  readonly ledger: ServerLedger
  readonly wire: Array<WireMessage>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  readonly calls: () => ReadonlyArray<WireMessage>
}

/**
 * `overrideCall` answers a `tools/call` with a hand-written result instead of the server (for
 * malformed payloads the official server would refuse to send).
 */
const makeHarness = (overrideCall?: (attempt: number) => unknown): Harness => {
  const ledger: ServerLedger = { minted: 0, executed: 0 }
  const handler = createMcpHandler(makeConfirmingServer(ledger))
  const wire: Array<WireMessage> = []
  let callAttempts = 0

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.gen(function* () {
        const body = Predicate.isTagged(request.body, 'Uint8Array')
          ? new TextDecoder().decode(request.body.body)
          : undefined

        const message = body === undefined ? Option.none() : decodeWireMessage(body)

        if (Option.isSome(message)) {
          wire.push(message.value)
        }

        if (
          overrideCall !== undefined &&
          Option.isSome(message) &&
          message.value.method === 'tools/call'
        ) {
          callAttempts += 1

          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              jsonrpc: '2.0',
              id: message.value.id,
              result: overrideCall(callAttempts)
            })
          )
        }

        const response = yield* Effect.promise(() =>
          handler.fetch(
            new Request(request.url, { method: request.method, headers: request.headers, body })
          )
        )

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

  return {
    ledger,
    wire,
    layer,
    calls: () => wire.filter(message => message.method === 'tools/call')
  }
}

const callInput = (options: McpClientOptions = optedIn) => ({
  config,
  mcpToolName: deleteTool.name,
  toolCallId: 'call_1',
  params: { invoiceId: 'INV-1' },
  options
})

const expectInputRequired = (outcome: McpToolCallOutcome) => {
  if (!Predicate.isTagged(outcome, 'InputRequired')) {
    throw new Error(`Expected InputRequired, got ${outcome._tag}`)
  }

  return outcome.inputRequired
}

const expectComplete = (outcome: McpToolCallOutcome) => {
  if (!Predicate.isTagged(outcome, 'Complete')) {
    throw new Error(`Expected Complete, got ${outcome._tag}`)
  }

  return outcome.result
}

const confirmed: McpElicitationResponses = {
  confirmation: { action: 'accept', content: { confirm: true } }
}

const inputRequiredResult = (inputRequests: unknown, requestState: unknown = 'opaque') => ({
  resultType: 'input_required',
  inputRequests,
  requestState
})

const formRequest = (params: unknown) => ({ method: 'elicitation/create', params })

const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined

describe('MCP form elicitation (MRTR)', () => {
  it.effect('declares elicitation.form per request only when the host opts in', () =>
    Effect.gen(function* () {
      const optedInHarness = makeHarness()

      yield* listRemoteMcpServerTools(config, optedIn).pipe(Effect.provide(optedInHarness.layer))
      yield* callRemoteMcpServerToolResumable(callInput()).pipe(
        Effect.provide(optedInHarness.layer)
      )

      const declared = optedInHarness.wire.filter(
        message => message.method === 'tools/list' || message.method === 'tools/call'
      )

      expect(declared.map(message => message.method)).toEqual([
        'tools/list',
        'tools/list',
        'tools/call'
      ])
      expect(declared.map(metaCapabilities)).toEqual(
        declared.map(() => ({ elicitation: { form: {} } }))
      )

      const plainHarness = makeHarness()

      yield* listRemoteMcpServerTools(config).pipe(Effect.provide(plainHarness.layer))

      const plainOutcome = yield* callRemoteMcpServerToolResumable(callInput({})).pipe(
        Effect.provide(plainHarness.layer)
      )

      expect(
        plainHarness.wire
          .filter(message => message.method !== 'server/discover')
          .map(metaCapabilities)
      ).toEqual([{}, {}, {}])
      expect(plainHarness.ledger.minted).toBe(0)

      const refused = expectComplete(plainOutcome)

      expect(refused.isError).toBe(true)
      expect(refused.content).toContain('CLIENT_CAPABILITY_REQUIRED')
    })
  )

  it.effect('never declares it through callRemoteMcpServerTool or a legacy initialize', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const result = yield* callRemoteMcpServerTool(callInput()).pipe(Effect.provide(harness.layer))

      expect(result.isError).toBe(true)
      expect(harness.calls().map(metaCapabilities)).toEqual([{}])

      const legacy = makeHarness()

      const outcome = yield* callRemoteMcpServerToolResumable(
        callInput(legacyOptions(optedIn))
      ).pipe(Effect.provide(legacy.layer))

      const initialize = legacy.wire.find(message => message.method === 'initialize')

      expect(
        Schema.decodeUnknownOption(InitializeParams)(initialize?.params).pipe(
          Option.map(params => params.capabilities),
          Option.getOrUndefined
        )
      ).toEqual({})
      expect(legacy.calls().map(metaCapabilities)).toEqual([undefined])
      expect(expectComplete(outcome).content).toContain('CLIENT_CAPABILITY_REQUIRED')
    })
  )

  it.effect('decodes InputRequired into a bounded, serializable value', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const outcome = yield* callRemoteMcpServerToolResumable(callInput()).pipe(
        Effect.provide(harness.layer)
      )

      const pending = expectInputRequired(outcome)

      expect(pending.requestState).toBe('opaque-state-1')
      expect(pending.elicitations).toHaveLength(1)
      expect(pending.elicitations[0]).toMatchObject({
        key: 'confirmation',
        message: 'Delete invoice INV-1?',
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', const: true, title: 'Delete it' } },
          required: ['confirm']
        }
      })
      expect(harness.ledger).toEqual({ minted: 1, executed: 0 })

      const persisted = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(McpInputRequired))(
        pending
      )

      const restored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(McpInputRequired))(
        persisted
      )

      expect(restored).toEqual(pending)

      const outcomeJson = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(McpToolCallOutcome)
      )(outcome)

      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolCallOutcome))(outcomeJson)
      ).toEqual(outcome)
    })
  )

  it.effect('resumes with the exact requestState and inputResponses under a new id', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      const outcome = yield* resumeRemoteMcpServerToolCall({
        ...callInput(),
        inputRequired: pending,
        responses: confirmed
      }).pipe(Effect.provide(harness.layer))

      const result = expectComplete(outcome)

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'deleted',
        structuredContent: { deleted: true }
      })
      expect(harness.ledger).toEqual({ minted: 1, executed: 1 })

      const [original, retry] = harness.calls()

      expect(original).toBeDefined()
      expect(retry).toBeDefined()

      if (original === undefined || retry === undefined) return

      expect(retry.id).not.toEqual(original.id)
      expect(retryParams(original)).toEqual({
        name: 'delete_invoice',
        arguments: { invoiceId: 'INV-1' }
      })
      expect(retryParams(retry)).toEqual({
        name: 'delete_invoice',
        arguments: { invoiceId: 'INV-1' },
        inputResponses: { confirmation: { action: 'accept', content: { confirm: true } } },
        requestState: 'opaque-state-1'
      })
      expect(metaCapabilities(retry)).toEqual({ elicitation: { form: {} } })
      expect(harness.wire.filter(message => message.method === 'tools/list')).toHaveLength(1)
    })
  )

  it.effect('passes decline and cancel back without executing', () =>
    Effect.gen(function* () {
      for (const action of ['decline', 'cancel'] as const) {
        const harness = makeHarness()

        const pending = expectInputRequired(
          yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
        )

        const result = expectComplete(
          yield* resumeRemoteMcpServerToolCall({
            ...callInput(),
            inputRequired: pending,
            responses: { confirmation: { action } }
          }).pipe(Effect.provide(harness.layer))
        )

        expect(result.isError).toBe(true)
        expect(result.content).toBe(`CONFIRMATION_${action.toUpperCase()}`)
        expect(harness.ledger.executed).toBe(0)
        expect(retryParams(harness.calls()[1] ?? { method: 'none' }).inputResponses).toEqual({
          confirmation: { action }
        })
      }
    })
  )

  it.effect('answers a second pause with a new InputRequired', () =>
    Effect.gen(function* () {
      const harness = makeHarness(attempt =>
        inputRequiredResult(
          {
            confirmation: formRequest({
              mode: 'form',
              message: `Round ${attempt}`,
              requestedSchema: confirmationSchema
            })
          },
          `state-${attempt}`
        )
      )

      const first = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      const second = expectInputRequired(
        yield* resumeRemoteMcpServerToolCall({
          ...callInput(),
          inputRequired: first,
          responses: confirmed
        }).pipe(Effect.provide(harness.layer))
      )

      expect(second.requestState).toBe('state-2')
      expect(second.elicitations[0]?.message).toBe('Round 2')
    })
  )

  it.effect('resumes a load-shedding pause without inputResponses', () =>
    Effect.gen(function* () {
      const harness = makeHarness(attempt =>
        attempt === 1
          ? { resultType: 'input_required', requestState: 'retry-later' }
          : { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
      )

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput({})).pipe(Effect.provide(harness.layer))
      )

      expect(pending.elicitations).toEqual([])

      const result = expectComplete(
        yield* resumeRemoteMcpServerToolCall({
          ...callInput({}),
          inputRequired: pending,
          responses: {}
        }).pipe(Effect.provide(harness.layer))
      )

      expect(result.content).toBe('done')
      expect(retryParams(harness.calls()[1] ?? { method: 'none' })).toEqual({
        name: 'delete_invoice',
        arguments: { invoiceId: 'INV-1' },
        requestState: 'retry-later'
      })
    })
  )

  it.effect('fails malformed InputRequired results with a typed error', () =>
    Effect.gen(function* () {
      const malformed: ReadonlyArray<readonly [unknown, string]> = [
        [inputRequiredResult({ confirmation: { params: {} } }), 'malformed'],
        [
          inputRequiredResult({
            confirmation: formRequest({ requestedSchema: confirmationSchema })
          }),
          'malformed'
        ],
        [
          inputRequiredResult({
            confirmation: formRequest({
              message: 'Nested?',
              requestedSchema: {
                type: 'object',
                properties: { address: { type: 'object' } }
              }
            })
          }),
          'malformed'
        ],
        [
          inputRequiredResult({
            confirmation: formRequest({
              message: 'Dangling?',
              requestedSchema: { type: 'object', properties: {}, required: ['confirm'] }
            })
          }),
          'malformed'
        ],
        [{ resultType: 'input_required' }, 'malformed'],
        [
          inputRequiredResult({
            confirmation: formRequest({
              mode: 'url',
              message: 'Open',
              url: 'https://mcp.example.test/confirm'
            })
          }),
          'unsupported_request'
        ],
        [
          inputRequiredResult({
            sample: {
              method: 'sampling/createMessage',
              params: { messages: [], maxTokens: 1 }
            }
          }),
          'unsupported_request'
        ]
      ]

      for (const [result, reason] of malformed) {
        const harness = makeHarness(() => result)

        const exit = yield* Effect.exit(
          callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
        )

        expect(failure(exit)).toMatchObject({
          _tag: 'McpInputRequiredError',
          server: 'books',
          reason
        })
      }
    })
  )

  it.effect('still validates complete results against the listed outputSchema', () =>
    Effect.gen(function* () {
      const invalid: ReadonlyArray<unknown> = [
        { resultType: 'complete', content: [], structuredContent: { deleted: 'no' } },
        { resultType: 'complete', content: [{ type: 'text', text: 'deleted' }] }
      ]

      for (const result of invalid) {
        const harness = makeHarness(() => result)

        const exit = yield* Effect.exit(
          callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
        )

        expect(failure(exit)).toMatchObject({ _tag: 'McpError', cause: 'protocol' })
      }

      const toolError = makeHarness(() => ({
        resultType: 'complete',
        content: [{ type: 'text', text: 'NOT_FOUND' }],
        isError: true
      }))

      expect(
        expectComplete(
          yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(toolError.layer))
        ).isError
      ).toBe(true)
    })
  )

  it.effect('refuses elicitations the host did not declare', () =>
    Effect.gen(function* () {
      const harness = makeHarness(() =>
        inputRequiredResult({
          confirmation: formRequest({ message: 'Sure?', requestedSchema: confirmationSchema })
        })
      )

      const exit = yield* Effect.exit(
        callRemoteMcpServerToolResumable(callInput({})).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({
        _tag: 'McpInputRequiredError',
        reason: 'unsupported_request'
      })
    })
  )

  it.effect('bounds the InputRequired payload', () =>
    Effect.gen(function* () {
      const oversized = makeHarness(() =>
        inputRequiredResult({
          confirmation: formRequest({
            message: 'x'.repeat(2_048),
            requestedSchema: confirmationSchema
          })
        })
      )

      const tooLarge = yield* Effect.exit(
        callRemoteMcpServerToolResumable(
          callInput({ elicitation: { form: true, maxInputRequiredBytes: 1_024 } })
        ).pipe(Effect.provide(oversized.layer))
      )

      expect(failure(tooLarge)).toMatchObject({
        _tag: 'McpInputRequiredError',
        reason: 'too_large'
      })

      const defaultBound = makeHarness(() =>
        inputRequiredResult({
          confirmation: formRequest({
            message: 'x'.repeat(70_000),
            requestedSchema: confirmationSchema
          })
        })
      )

      expect(
        failure(
          yield* Effect.exit(
            callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(defaultBound.layer))
          )
        )
      ).toMatchObject({ reason: 'too_large' })

      const crowded = makeHarness(() =>
        inputRequiredResult(
          Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [
              `field_${index}`,
              formRequest({ message: 'Sure?', requestedSchema: confirmationSchema })
            ])
          )
        )
      )

      expect(
        failure(
          yield* Effect.exit(
            callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(crowded.layer))
          )
        )
      ).toMatchObject({ reason: 'too_large' })
    })
  )

  it.effect('surfaces MCP -32021 as McpClientCapabilityRequiredError', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const exit = yield* Effect.exit(
        callRemoteMcpServerToolResumable({
          ...callInput({}),
          mcpToolName: capabilityTool.name,
          params: {}
        }).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({
        _tag: 'McpClientCapabilityRequiredError',
        server: 'books',
        requiredCapabilities: { elicitation: { form: {} } }
      })
    })
  )

  it.effect('checks decisions against the elicitations before sending', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      const invalid: ReadonlyArray<McpElicitationResponses> = [
        {},
        { other: { action: 'decline' } },
        { confirmation: { action: 'decline' }, other: { action: 'cancel' } },
        { confirmation: { action: 'accept', content: {} } },
        { confirmation: { action: 'accept', content: { confirm: 'yes' } } },
        { confirmation: { action: 'accept', content: { confirm: true, extra: 1 } } }
      ]

      for (const responses of invalid) {
        const exit = yield* Effect.exit(
          resumeRemoteMcpServerToolCall({ ...callInput(), inputRequired: pending, responses }).pipe(
            Effect.provide(harness.layer)
          )
        )

        expect(failure(exit)).toMatchObject({ reason: 'invalid_responses' })
      }

      expect(harness.calls()).toHaveLength(1)
      expect(harness.ledger.executed).toBe(0)
    })
  )

  it.effect('refuses to resume on a legacy-era connection', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const exit = yield* Effect.exit(
        resumeRemoteMcpServerToolCall({
          ...callInput(legacyOptions(optedIn)),
          inputRequired: McpInputRequired.make({ elicitations: [], requestState: 'opaque' }),
          responses: {}
        }).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({
        _tag: 'McpInputRequiredError',
        reason: 'unsupported_era'
      })
      expect(harness.calls()).toHaveLength(0)
    })
  )
})
