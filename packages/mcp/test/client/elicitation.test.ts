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
  InMemoryResponseCacheStore,
  mcpArgumentsDigest,
  McpFormElicitation,
  McpPausedTool,
  toMcpInputResponses,
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
    properties: { invoiceId: { type: 'string', 'x-mcp-header': 'Invoice-Id' } },
    required: ['invoiceId']
  },
  outputSchema: {
    type: 'object',
    properties: { deleted: { type: 'boolean' } },
    required: ['deleted']
  },
  annotations: { destructiveHint: true }
}

/** Its definition alone is larger than a tight `maxInputRequiredBytes`. */
const bigSchemaTool: Tool = {
  name: 'big_schema',
  description: 'Lists a large input schema.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', description: 'x'.repeat(4_000) } }
  }
}

/** Its `outputSchema` does not compile (invalid regular expression). */
const brokenOutputTool: Tool = {
  name: 'broken_output',
  description: 'Lists an output schema that does not compile.',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '(' } } }
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
  // Cacheable listings, so a host `responseCacheStore` holds the listed output schemas.
  const server = new McpServer(
    { name: 'confirming', version: '1.0.0' },
    { cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } } }
  )

  server.server.registerCapabilities({ tools: { listChanged: false } })
  server.server.setRequestHandler('tools/list', () => ({
    tools: [deleteTool, brokenOutputTool, bigSchemaTool, capabilityTool]
  }))
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
  /** The `mcp-param-invoice-id` header of every tools/call, in order. */
  readonly invoiceHeaders: Array<string | undefined>
  /** The body of every server answer to a tools/call, in order. */
  readonly callAnswers: Array<string>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  readonly calls: () => ReadonlyArray<WireMessage>
}

/**
 * `overrideCall` answers a `tools/call` with a hand-written result instead of the server (for
 * malformed payloads the official server would refuse to send).
 */
/** A raw answer to a tools/call, given the call's JSON-RPC id. */
type CallAnswer = (id: string | number | undefined) => Response

const makeHarness = (
  overrideCall?: (attempt: number) => unknown,
  answerCall?: CallAnswer
): Harness => {
  const ledger: ServerLedger = { minted: 0, executed: 0 }
  const handler = createMcpHandler(makeConfirmingServer(ledger))
  const wire: Array<WireMessage> = []
  const invoiceHeaders: Array<string | undefined> = []
  const callAnswers: Array<string> = []
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

        if (Option.isSome(message) && message.value.method === 'tools/call') {
          invoiceHeaders.push(request.headers['mcp-param-invoice-id'])
        }

        if (
          answerCall !== undefined &&
          Option.isSome(message) &&
          message.value.method === 'tools/call'
        ) {
          return HttpClientResponse.fromWeb(request, answerCall(message.value.id))
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

        if (Option.isSome(message) && message.value.method === 'tools/call') {
          callAnswers.push(yield* Effect.promise(() => response.clone().text()))
        }

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

  return {
    ledger,
    wire,
    invoiceHeaders,
    callAnswers,
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
      expect(pending.mcpToolName).toBe('delete_invoice')
      expect(pending.argumentsDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(pending.tool).toMatchObject({
        name: 'delete_invoice',
        inputSchema: deleteTool.inputSchema,
        outputSchema: deleteTool.outputSchema
      })

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

  it.effect('resumes with the exact requestState and inputResponses as a new request', () =>
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
      // The resume mirrors x-mcp-header from the pause's definition, without listing.
      expect(harness.invoiceHeaders).toEqual(['INV-1', 'INV-1'])
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
          : {
              resultType: 'complete',
              content: [{ type: 'text', text: 'done' }],
              structuredContent: { deleted: true }
            }
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

  it.effect('validates resumed results against the paused outputSchema', () =>
    Effect.gen(function* () {
      const harness = makeHarness(attempt =>
        attempt === 1
          ? inputRequiredResult({
              confirmation: formRequest({ message: 'Sure?', requestedSchema: confirmationSchema })
            })
          : { resultType: 'complete', content: [], structuredContent: { deleted: 'no' } }
      )

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      const exit = yield* Effect.exit(
        resumeRemoteMcpServerToolCall({
          ...callInput(),
          inputRequired: pending,
          responses: confirmed
        }).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({ _tag: 'McpError', cause: 'protocol' })
      expect(failure(exit)?.message).toContain("does not match the tool's output schema")
    })
  )

  it.effect('pauses again with a host responseCacheStore that holds the outputSchema', () =>
    Effect.gen(function* () {
      const options: McpClientOptions = {
        elicitation: { form: true },
        sdk: { responseCacheStore: new InMemoryResponseCacheStore() }
      }

      const harness = makeHarness(attempt =>
        inputRequiredResult(
          {
            confirmation: formRequest({
              message: `Round ${attempt}`,
              requestedSchema: confirmationSchema
            })
          },
          `state-${attempt}`
        )
      )

      const first = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput(options)).pipe(
          Effect.provide(harness.layer)
        )
      )

      const second = expectInputRequired(
        yield* resumeRemoteMcpServerToolCall({
          ...callInput(options),
          inputRequired: first,
          responses: confirmed
        }).pipe(Effect.provide(harness.layer))
      )

      expect(second.requestState).toBe('state-2')
      expect(second.tool).toEqual(first.tool)
    })
  )

  it.effect('compiles the outputSchema before calling', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const exit = yield* Effect.exit(
        callRemoteMcpServerToolResumable({
          ...callInput(),
          mcpToolName: brokenOutputTool.name,
          params: {}
        }).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({ _tag: 'McpError', cause: 'protocol' })
      expect(failure(exit)?.message).toContain("Tool 'broken_output' has an invalid outputSchema")
      expect(harness.calls()).toHaveLength(0)
    })
  )

  it.effect('reports a throwing output validator as a validation failure', () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => ({
        resultType: 'complete',
        content: [],
        structuredContent: { deleted: true }
      }))

      const exit = yield* Effect.exit(
        callRemoteMcpServerToolResumable(
          callInput({
            elicitation: { form: true },
            sdk: {
              jsonSchemaValidator: {
                getValidator: () => () => {
                  throw new Error('validator exploded')
                }
              }
            }
          })
        ).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({ _tag: 'McpError', cause: 'protocol' })
      expect(failure(exit)?.message).toContain(
        'Failed to validate structured content: validator exploded'
      )
    })
  )

  it.effect('needs a positive integer maxInputRequiredBytes before connecting', () =>
    Effect.gen(function* () {
      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(
          Effect.provide(makeHarness().layer)
        )
      )

      for (const maxInputRequiredBytes of [0, -1, 1.5, Number.NaN]) {
        const harness = makeHarness()
        const options: McpClientOptions = { elicitation: { form: true, maxInputRequiredBytes } }

        const exits = [
          yield* Effect.exit(
            callRemoteMcpServerToolResumable(callInput(options)).pipe(Effect.provide(harness.layer))
          ),
          yield* Effect.exit(
            resumeRemoteMcpServerToolCall({
              ...callInput(options),
              inputRequired: pending,
              responses: confirmed
            }).pipe(Effect.provide(harness.layer))
          )
        ]

        for (const exit of exits) {
          expect(failure(exit)).toMatchObject({
            _tag: 'McpInputRequiredError',
            reason: 'malformed'
          })
        }

        // Refused before connecting: nothing reached the server.
        expect(harness.wire).toEqual([])
      }
    })
  )

  it.effect('bounds the carried tool definition on its own, before the call', () =>
    Effect.gen(function* () {
      const tight = makeHarness()

      const tooLarge = yield* Effect.exit(
        callRemoteMcpServerToolResumable({
          ...callInput({ elicitation: { form: true, maxInputRequiredBytes: 2_048 } }),
          mcpToolName: bigSchemaTool.name,
          params: {}
        }).pipe(Effect.provide(tight.layer))
      )

      expect(failure(tooLarge)).toMatchObject({
        _tag: 'McpInputRequiredError',
        reason: 'too_large'
      })
      expect(failure(tooLarge)?.message).toContain('The listed definition of big_schema')
      // The call was never sent, so no pause exists that could not be persisted.
      expect(tight.calls()).toHaveLength(0)

      // The definition and the server-provided pause each fit the bound; together they do not.
      const measured = makeHarness()

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(measured.layer))
      )

      const answer = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ result: Schema.Unknown }))
      )(measured.callAnswers[0] ?? '')

      const json = (value: unknown) =>
        Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
          Effect.map(text => new TextEncoder().encode(text).byteLength)
        )

      const toolBytes = yield* json(pending.tool)
      const pauseBytes = yield* json({ ...pending, tool: undefined })
      const totalBytes = yield* json(pending)
      // The raw InputRequiredResult (as the server sent it) is bounded too.
      const rawBytes = yield* json(answer.result)
      const bound = Math.max(toolBytes, pauseBytes, rawBytes) + 64

      expect(totalBytes).toBeGreaterThan(bound)

      const fits = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(
          callInput({ elicitation: { form: true, maxInputRequiredBytes: bound } })
        ).pipe(Effect.provide(makeHarness().layer))
      )

      expect(fits.tool).toEqual(pending.tool)
    })
  )

  it.effect('refuses a resume whose carried tool definition is not a valid tool', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      const corrupted = McpInputRequired.make({
        elicitations: pending.elicitations,
        mcpToolName: pending.mcpToolName,
        argumentsDigest: pending.argumentsDigest,
        requestState: pending.requestState ?? '',
        tool: McpPausedTool.make({ name: 'delete_invoice', inputSchema: { type: 'string' } })
      })

      const exit = yield* Effect.exit(
        resumeRemoteMcpServerToolCall({
          ...callInput(),
          inputRequired: corrupted,
          responses: confirmed
        }).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({ _tag: 'McpInputRequiredError', reason: 'malformed' })
      expect(harness.calls()).toHaveLength(1)
      expect(harness.ledger.executed).toBe(0)
    })
  )

  it.effect('binds the pause to its tool and arguments', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable({
          ...callInput(),
          params: { invoiceId: 'INV-1', note: { b: 1, a: 2 } }
        }).pipe(Effect.provide(harness.layer))
      )

      const mismatched = [
        { mcpToolName: capabilityTool.name, params: { invoiceId: 'INV-1', note: { a: 2, b: 1 } } },
        { mcpToolName: deleteTool.name, params: { invoiceId: 'INV-2', note: { a: 2, b: 1 } } }
      ]

      for (const call of mismatched) {
        const exit = yield* Effect.exit(
          resumeRemoteMcpServerToolCall({
            ...callInput(),
            ...call,
            inputRequired: pending,
            responses: confirmed
          }).pipe(Effect.provide(harness.layer))
        )

        expect(failure(exit)).toMatchObject({
          _tag: 'McpInputRequiredError',
          reason: 'mismatched_resume'
        })
      }

      expect(harness.calls()).toHaveLength(1)

      // Key order does not matter: the digest is over canonical JSON.
      const result = expectComplete(
        yield* resumeRemoteMcpServerToolCall({
          ...callInput(),
          params: { note: { a: 2, b: 1 }, invoiceId: 'INV-1' },
          inputRequired: pending,
          responses: confirmed
        }).pipe(Effect.provide(harness.layer))
      )

      expect(result.structuredContent).toEqual({ deleted: true })
    })
  )

  it.effect('checks enum, titled options and string-list items before sending', () =>
    Effect.gen(function* () {
      const pending = McpInputRequired.make({
        mcpToolName: 'pick',
        argumentsDigest: 'sha256:0',
        elicitations: [
          McpFormElicitation.make({
            key: 'form',
            message: 'Pick',
            requestedSchema: {
              type: 'object',
              properties: {
                size: { type: 'string', enum: ['s', 'm'] },
                color: { type: 'string', oneOf: [{ const: '#f00', title: 'Red' }] },
                tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
                labels: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }] } }
              }
            }
          })
        ]
      })

      const check = (content: Record<string, string | ReadonlyArray<string>>) =>
        toMcpInputResponses({
          server: 'books',
          inputRequired: pending,
          responses: { form: { action: 'accept', content } }
        }).pipe(Effect.exit)

      expect(
        Exit.isSuccess(yield* check({ size: 'm', color: '#f00', tags: ['a', 'b'], labels: ['x'] }))
      ).toBe(true)

      const rejected: ReadonlyArray<Record<string, string | ReadonlyArray<string>>> = [
        { size: 'xl' },
        { color: '#0f0' },
        { tags: ['a', 'c'] },
        { labels: ['y'] }
      ]

      for (const content of rejected) {
        expect(failure(yield* check(content)), JSON.stringify(content)).toMatchObject({
          reason: 'invalid_responses'
        })
      }
    })
  )

  it.effect('enforces the form-schema subset bounds at their boundaries', () =>
    Effect.gen(function* () {
      const pending = McpInputRequired.make({
        mcpToolName: 'fill',
        argumentsDigest: 'sha256:0',
        elicitations: [
          McpFormElicitation.make({
            key: 'form',
            message: 'Fill',
            requestedSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 2, maxLength: 4 },
                email: { type: 'string', format: 'email' },
                site: { type: 'string', format: 'uri' },
                day: { type: 'string', format: 'date' },
                at: { type: 'string', format: 'date-time' },
                score: { type: 'number', minimum: 1, maximum: 10 },
                count: { type: 'integer', minimum: 0 },
                tags: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 2,
                  items: { type: 'string', enum: ['a', 'b', 'c'] }
                }
              }
            }
          })
        ]
      })

      const check = (content: Record<string, string | number | ReadonlyArray<string>>) =>
        toMcpInputResponses({
          server: 'books',
          inputRequired: pending,
          responses: { form: { action: 'accept', content } }
        }).pipe(Effect.exit)

      const accepted: ReadonlyArray<Record<string, string | number | ReadonlyArray<string>>> = [
        { name: 'ab' },
        { name: 'abcd' },
        // Code points, not UTF-16 units.
        { name: '🔐🔐' },
        { email: 'a@b.co' },
        { email: 'first.last@example.com' },
        { email: "o'neil+tag@sub.example-mail.co" },
        { site: 'https://x.test/a?b=1#frag' },
        { site: 'urn:isbn:0451450523' },
        { site: 'mailto:a@example.com' },
        { site: 'https://[::1]:8080/p' },
        { site: 'https://example.com/a%20b' },
        { site: 'foo:' },
        { day: '2024-02-29' },
        { day: '2000-02-29' },
        // Years 0-99: no Date.UTC remapping.
        { day: '0099-01-01' },
        { day: '0000-02-29' },
        { at: '2026-10-13T08:00:00Z' },
        { at: '2026-10-13T08:00:00.123+02:00' },
        { at: '0099-01-01T00:00:00z' },
        { at: '2026-12-31T23:59:60.5-11:30' },
        { score: 1 },
        { score: 10 },
        { score: 5.5 },
        { count: 0 },
        { tags: ['a'] },
        { tags: ['a', 'b'] }
      ]

      for (const content of accepted) {
        expect(Exit.isSuccess(yield* check(content)), JSON.stringify(content)).toBe(true)
      }

      const rejected: ReadonlyArray<Record<string, string | number | ReadonlyArray<string>>> = [
        { name: 'a' },
        { name: 'abcde' },
        { email: 'nope' },
        { email: 'a b@c.d' },
        { email: 'a..b@example.com' },
        { email: '.a@example.com' },
        { email: 'a.@example.com' },
        { email: 'a@b' },
        { email: 'a@-b.com' },
        { email: 'a@b-.com' },
        { email: 'a@b..com' },
        { email: '"quoted"@example.com' },
        { site: 'not a uri' },
        { site: '/relative' },
        // WHATWG URL parsing would accept and normalise these.
        { site: 'https://example.com/a b' },
        { site: 'https://exa mple.com/' },
        { site: 'https://example.com/ü' },
        { site: 'https://example.com/%zz' },
        { site: 'http://x/#a#b' },
        { site: '1http://x' },
        { day: '2026-02-30' },
        { day: '1900-02-29' },
        { day: '2026-13-01' },
        { day: '2026-00-10' },
        { day: '2026-2-1' },
        { at: '2026-10-13 08:00:00Z' },
        { at: '2026-10-13T24:00:00Z' },
        { at: '2026-10-13T08:00:00' },
        { at: '2026-10-13T08:00:00.Z' },
        { at: '2026-10-13T08:00:00+24:00' },
        { at: '2026-10-13T08:00:00+0200' },
        { score: 0.999 },
        { score: 10.001 },
        { count: -1 },
        { count: 1.5 },
        { tags: [] },
        { tags: ['a', 'b', 'c'] }
      ]

      for (const content of rejected) {
        expect(failure(yield* check(content)), JSON.stringify(content)).toMatchObject({
          reason: 'invalid_responses'
        })
      }
    })
  )

  it.effect('refuses an out-of-bounds decision with no resume call', () =>
    Effect.gen(function* () {
      const harness = makeHarness(attempt =>
        attempt === 1
          ? inputRequiredResult({
              form: formRequest({
                message: 'How many?',
                requestedSchema: {
                  type: 'object',
                  properties: { copies: { type: 'integer', minimum: 1, maximum: 3 } },
                  required: ['copies']
                }
              })
            })
          : { resultType: 'complete', content: [], structuredContent: { deleted: true } }
      )

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      const exit = yield* Effect.exit(
        resumeRemoteMcpServerToolCall({
          ...callInput(),
          inputRequired: pending,
          responses: { form: { action: 'accept', content: { copies: 4 } } }
        }).pipe(Effect.provide(harness.layer))
      )

      expect(failure(exit)).toMatchObject({ reason: 'invalid_responses' })
      expect(harness.calls()).toHaveLength(1)
    })
  )

  it.effect('validates the raw input_required envelope, not the SDK normalised one', () =>
    Effect.gen(function* () {
      const form = formRequest({ message: 'Sure?', requestedSchema: confirmationSchema })

      const corrupted: ReadonlyArray<unknown> = [
        // The SDK would drop the state: the resume would lose it.
        { resultType: 'input_required', inputRequests: { confirmation: form }, requestState: 123 },
        // The SDK would turn the requests into {}: a load-shedding pause.
        { resultType: 'input_required', inputRequests: 'garbage', requestState: 'opaque' },
        { resultType: 'input_required', inputRequests: [form], requestState: 'opaque' },
        { resultType: 'input_required', inputRequests: null, requestState: 'opaque' }
      ]

      for (const raw of corrupted) {
        const harness = makeHarness(() => raw)

        const exit = yield* Effect.exit(
          callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
        )

        expect(failure(exit), JSON.stringify(raw)).toMatchObject({
          _tag: 'McpInputRequiredError',
          reason: 'malformed'
        })
      }

      // A well-formed raw pause still decodes, with its state.
      const harness = makeHarness(() => ({
        resultType: 'input_required',
        inputRequests: { confirmation: form },
        requestState: 'opaque'
      }))

      expect(
        expectInputRequired(
          yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
        ).requestState
      ).toBe('opaque')
    })
  )

  it.effect('keeps only the response with the call id (SSE and JSON batches)', () =>
    Effect.gen(function* () {
      const form = formRequest({ message: 'Sure?', requestedSchema: confirmationSchema })

      const pause = (requestState: unknown) => ({
        resultType: 'input_required',
        inputRequests: { confirmation: form },
        requestState
      })

      const response = (id: string | number | undefined, result: unknown) => ({
        jsonrpc: '2.0',
        id,
        result
      })

      const notification = {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', data: 'working' }
      }

      const sse = (messages: ReadonlyArray<unknown>) =>
        new Response(
          messages.map(message => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        )

      // Around the matching response: a notification, an unrelated id, the listing's id (0),
      // a duplicate of the call id, and a late unrelated response. Each holds a malformed
      // pause that would fail the call if it were taken.
      const answers: ReadonlyArray<CallAnswer> = [
        id =>
          sse([
            notification,
            response('unrelated', pause(1)),
            response(0, pause(2)),
            response(id, pause('right')),
            response(id, pause(3)),
            response('late', pause(4))
          ]),
        id =>
          Response.json([
            response('unrelated', pause(1)),
            response(id, pause('right')),
            response('late', pause(4))
          ])
      ]

      for (const answer of answers) {
        const harness = makeHarness(undefined, answer)

        const pending = expectInputRequired(
          yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
        )

        expect(pending.requestState).toBe('right')
      }

      // Nothing with the call id: fails closed.
      const unanswered = makeHarness(undefined, id =>
        sse([response('unrelated', pause('wrong')), response(id, pause(5))])
      )

      expect(
        failure(
          yield* Effect.exit(
            callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(unanswered.layer))
          )
        )
      ).toMatchObject({ _tag: 'McpInputRequiredError', reason: 'malformed' })
    })
  )

  it.effect('a server form key __proto__ survives to the resume wire', () =>
    Effect.gen(function* () {
      const harness = makeHarness(attempt =>
        attempt === 1
          ? {
              resultType: 'input_required',
              inputRequests: JSON.parse(
                JSON.stringify({ '!': 0 }).replace(
                  '"!":0',
                  `"__proto__":${JSON.stringify(
                    formRequest({ message: 'Sure?', requestedSchema: confirmationSchema })
                  )}`
                )
              ),
              requestState: 'opaque'
            }
          : { resultType: 'complete', content: [], structuredContent: { deleted: true } }
      )

      const pending = expectInputRequired(
        yield* callRemoteMcpServerToolResumable(callInput()).pipe(Effect.provide(harness.layer))
      )

      expect(pending.elicitations.map(form => form.key)).toEqual(['__proto__'])

      const responses = Object.fromEntries(
        pending.elicitations.map(form => [
          form.key,
          { action: 'accept' as const, content: { confirm: true } }
        ])
      )

      yield* resumeRemoteMcpServerToolCall({
        ...callInput(),
        inputRequired: pending,
        responses
      }).pipe(Effect.provide(harness.layer))

      const retry = harness.calls()[1]
      const sent = retry === undefined ? undefined : retryParams(retry).inputResponses

      expect(Object.keys(Object(sent))).toEqual(['__proto__'])
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
            message: 'x'.repeat(300_000),
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
        { confirmation: { action: 'accept', content: { confirm: true, extra: 1 } } },
        // `const: true` in the requested schema.
        { confirmation: { action: 'accept', content: { confirm: false } } }
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
          inputRequired: McpInputRequired.make({
            elicitations: [],
            requestState: 'opaque',
            mcpToolName: deleteTool.name,
            argumentsDigest: yield* mcpArgumentsDigest(callInput().params)
          }),
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
