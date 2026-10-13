/**
 * MCP form elicitation over multi round-trip requests (MRTR, protocol `2026-07-28`), modelled for
 * durable hosts: the client never blocks on a human. A `tools/call` answered with an
 * `InputRequiredResult` becomes a serializable `McpInputRequired` value (bounded, Schema-decoded
 * form elicitations plus the opaque `requestState`). The host persists it, collects the decisions
 * however and whenever it likes (possibly in another process), and resumes the call with
 * `McpElicitationResponses`. The resume re-sends the original tool call with the exact
 * `requestState` and the `inputResponses`.
 *
 * Only form mode is supported. URL-mode elicitation, sampling and roots requests are refused with
 * `McpInputRequiredError` (`unsupported_request`); the client never declares them.
 */
import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { McpInputRequiredError, type McpInputRequiredErrorReason } from './errors.ts'

/** Default bound on one `InputRequiredResult` (its JSON encoding, in UTF-8 bytes). */
export const defaultMcpMaxInputRequiredBytes = 65_536

/** Most embedded input requests one `InputRequiredResult` may carry. */
export const mcpMaxInputRequests = 16

/**
 * Host opt-in to MCP form elicitation. Declare it only when the host can present a form with
 * accept, decline and cancel choices, persist the pending call, and resume it later.
 */
export type McpElicitationSupport = {
  readonly form: true
  /** Bound on one `InputRequiredResult` (JSON, UTF-8 bytes). Default `65_536`. */
  readonly maxInputRequiredBytes?: number
}

/** Property types a form `requestedSchema` may use: flat primitives and string multi-selects. */
export const McpElicitationPropertyType = Schema.Literals([
  'string',
  'number',
  'integer',
  'boolean',
  'array'
])

export type McpElicitationPropertyType = typeof McpElicitationPropertyType.Type

/**
 * One `requestedSchema` property, kept as received (`title`, `description`, `enum`, `oneOf`,
 * `const`, `default`, bounds, `format`), so the host can render it.
 */
export const McpElicitationProperty = Schema.StructWithRest(
  Schema.Struct({ type: McpElicitationPropertyType }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export type McpElicitationProperty = typeof McpElicitationProperty.Type

/** The restricted JSON Schema of a form elicitation: one flat object. */
export const McpElicitationRequestedSchema = Schema.Struct({
  type: Schema.Literal('object'),
  properties: Schema.Record(Schema.String, McpElicitationProperty),
  required: Schema.optional(Schema.Array(Schema.String))
})

export type McpElicitationRequestedSchema = typeof McpElicitationRequestedSchema.Type

/** One form elicitation the server asked for. `key` is the server's `inputRequests` key. */
export class McpFormElicitation extends Schema.Class<McpFormElicitation>('McpFormElicitation')({
  key: Schema.String,
  message: Schema.String,
  requestedSchema: McpElicitationRequestedSchema
}) {}

/**
 * A tool call the server paused for input: serializable, safe to persist. `requestState` is
 * opaque server state, echoed back byte-exact on resume; never inspect or change it. No
 * `elicitations` with a `requestState` is a load-shedding pause: resume with no responses.
 */
export class McpInputRequired extends Schema.Class<McpInputRequired>('McpInputRequired')({
  elicitations: Schema.Array(McpFormElicitation),
  requestState: Schema.optional(Schema.String)
}) {}

/** A value a form may return: the MCP `ElicitResult.content` value types. */
export const McpElicitationContentValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String)
])

export type McpElicitationContentValue = typeof McpElicitationContentValue.Type

/** The user's decision on one form elicitation (MCP `ElicitResult`, form mode). */
export const McpElicitationResponse = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('accept'),
    content: Schema.Record(Schema.String, McpElicitationContentValue)
  }),
  Schema.Struct({ action: Schema.Literal('decline') }),
  Schema.Struct({ action: Schema.Literal('cancel') })
])

export type McpElicitationResponse = typeof McpElicitationResponse.Type

/** Decisions keyed by `McpFormElicitation.key`: exactly one per elicitation. */
export const McpElicitationResponses = Schema.Record(Schema.String, McpElicitationResponse)

export type McpElicitationResponses = typeof McpElicitationResponses.Type

/** The tool call finished; `result` is the adapted MCP `CallToolResult`. */
export class McpToolCallComplete extends Schema.TaggedClass<McpToolCallComplete>()('Complete', {
  result: ToolResult
}) {}

/** The server paused the tool call for input; persist `inputRequired` and resume later. */
export class McpToolCallInputRequired extends Schema.TaggedClass<McpToolCallInputRequired>()(
  'InputRequired',
  { inputRequired: McpInputRequired }
) {}

export const McpToolCallOutcome = Schema.Union([McpToolCallComplete, McpToolCallInputRequired])

export type McpToolCallOutcome = typeof McpToolCallOutcome.Type

/** Wire `inputResponses` value of one form elicitation (MCP `ElicitResult`). */
export type McpWireElicitResult = {
  action: 'accept' | 'decline' | 'cancel'
  content?: { [key: string]: string | number | boolean | Array<string> }
}

type McpWireInputResponse = readonly [string, McpWireElicitResult]

const InputRequiredPayload = Schema.Struct({
  resultType: Schema.Literal('input_required'),
  inputRequests: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  requestState: Schema.optional(Schema.String)
})

const InputRequest = Schema.Struct({ method: Schema.String, params: Schema.Unknown })

const ElicitationMode = Schema.Struct({ mode: Schema.optional(Schema.String) })

const FormElicitationParams = Schema.Struct({
  mode: Schema.optional(Schema.Literal('form')),
  message: Schema.String,
  requestedSchema: McpElicitationRequestedSchema
})

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const inputRequiredError = (server: string, reason: McpInputRequiredErrorReason, message: string) =>
  Effect.fail(new McpInputRequiredError({ server, reason, message }))

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength

const danglingRequired = (schema: McpElicitationRequestedSchema) =>
  (schema.required ?? []).filter(name => !Object.hasOwn(schema.properties, name))

const decodeElicitation = (server: string, key: string, raw: unknown) =>
  Effect.gen(function* () {
    const position = `inputRequests entry ${JSON.stringify(key)}`

    const request = yield* Schema.decodeUnknownEffect(InputRequest)(raw).pipe(
      Effect.catch(() =>
        inputRequiredError(server, 'malformed', `${position} is not an input request`)
      )
    )

    if (request.method !== 'elicitation/create') {
      return yield* inputRequiredError(
        server,
        'unsupported_request',
        `${position} is ${request.method}; only form elicitation is supported`
      )
    }

    const mode = Schema.decodeUnknownOption(ElicitationMode)(request.params).pipe(
      Option.flatMap(params => Option.fromNullishOr(params.mode))
    )

    if (Option.isSome(mode) && mode.value !== 'form') {
      return yield* inputRequiredError(
        server,
        'unsupported_request',
        `${position} is a ${mode.value}-mode elicitation; only form mode is supported`
      )
    }

    const params = yield* Schema.decodeUnknownEffect(FormElicitationParams)(request.params).pipe(
      Effect.catch(error =>
        inputRequiredError(server, 'malformed', `${position} is not a form elicitation: ${error}`)
      )
    )

    const dangling = danglingRequired(params.requestedSchema)

    if (dangling.length > 0) {
      return yield* inputRequiredError(
        server,
        'malformed',
        `${position} requires undeclared properties: ${dangling.join(', ')}`
      )
    }

    return McpFormElicitation.make({
      key,
      message: params.message,
      requestedSchema: params.requestedSchema
    })
  })

/**
 * Decodes an `InputRequiredResult` (as the official client hands it back in manual mode) into a
 * bounded `McpInputRequired`. Fails with `McpInputRequiredError`: `too_large` over the byte or
 * request-count bound, `unsupported_request` for anything but form elicitation (or for any
 * elicitation when the host did not opt in), `malformed` otherwise.
 */
export const decodeMcpInputRequired = (input: {
  readonly server: string
  readonly raw: unknown
  readonly elicitation: McpElicitationSupport | undefined
}): Effect.Effect<McpInputRequired, McpInputRequiredError> =>
  Effect.gen(function* () {
    const maxBytes = input.elicitation?.maxInputRequiredBytes ?? defaultMcpMaxInputRequiredBytes

    const json = yield* encodeJson(input.raw).pipe(
      Effect.catch(() =>
        inputRequiredError(input.server, 'malformed', 'InputRequiredResult is not JSON')
      )
    )

    const bytes = utf8Bytes(json)

    if (bytes > maxBytes) {
      return yield* inputRequiredError(
        input.server,
        'too_large',
        `InputRequiredResult is ${bytes} bytes; the limit is ${maxBytes}`
      )
    }

    const payload = yield* Schema.decodeUnknownEffect(InputRequiredPayload)(input.raw).pipe(
      Effect.catch(error =>
        inputRequiredError(input.server, 'malformed', `Invalid InputRequiredResult: ${error}`)
      )
    )

    const entries = Object.entries(payload.inputRequests ?? {})

    if (entries.length === 0 && payload.requestState === undefined) {
      return yield* inputRequiredError(
        input.server,
        'malformed',
        'InputRequiredResult carries neither inputRequests nor requestState'
      )
    }

    if (entries.length > mcpMaxInputRequests) {
      return yield* inputRequiredError(
        input.server,
        'too_large',
        `InputRequiredResult carries ${entries.length} input requests; the limit is ${mcpMaxInputRequests}`
      )
    }

    if (entries.length > 0 && input.elicitation === undefined) {
      return yield* inputRequiredError(
        input.server,
        'unsupported_request',
        'InputRequiredResult asks for input, but the host did not declare form elicitation'
      )
    }

    const elicitations = yield* Effect.forEach(entries, ([key, raw]) =>
      decodeElicitation(input.server, key, raw)
    )

    return payload.requestState === undefined
      ? McpInputRequired.make({ elicitations })
      : McpInputRequired.make({ elicitations, requestState: payload.requestState })
  })

const isString = Schema.is(Schema.String)

const isFiniteNumber = Schema.is(Schema.Finite)

const isInteger = Schema.is(Schema.Int)

const isBoolean = Schema.is(Schema.Boolean)

const isStringArray = Schema.is(Schema.Array(Schema.String))

const matchesPropertyType = (
  type: McpElicitationPropertyType,
  value: McpElicitationContentValue
) => {
  switch (type) {
    case 'string':
      return isString(value)
    case 'number':
      return isFiniteNumber(value)
    case 'integer':
      return isInteger(value)
    case 'boolean':
      return isBoolean(value)
    case 'array':
      return isStringArray(value)
  }
}

const contentProblems = (
  elicitation: McpFormElicitation,
  content: Readonly<Record<string, McpElicitationContentValue>>
) => {
  const { properties, required } = elicitation.requestedSchema

  const undeclared = Object.keys(content)
    .filter(name => !Object.hasOwn(properties, name))
    .map(name => `${name} is not in requestedSchema`)

  const missing = (required ?? [])
    .filter(name => !Object.hasOwn(content, name))
    .map(name => `${name} is required`)

  const mistyped = Object.entries(content).flatMap(([name, value]) => {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined

    return property === undefined || matchesPropertyType(property.type, value)
      ? []
      : [`${name} is not a ${property.type}`]
  })

  return [...undeclared, ...missing, ...mistyped]
}

const wireContent = (content: Readonly<Record<string, McpElicitationContentValue>>) =>
  Object.fromEntries(
    Object.entries(content).map(([name, value]) => [
      name,
      isStringArray(value) ? Array.from(value) : value
    ])
  )

const wireResponse = (response: McpElicitationResponse): McpWireElicitResult =>
  response.action === 'accept'
    ? { action: 'accept', content: wireContent(response.content) }
    : { action: response.action }

const wireInputResponse = (
  server: string,
  elicitation: McpFormElicitation,
  response: McpElicitationResponse | undefined
): Effect.Effect<McpWireInputResponse, McpInputRequiredError> => {
  const key = JSON.stringify(elicitation.key)

  if (response === undefined) {
    return inputRequiredError(server, 'invalid_responses', `no response for ${key}`)
  }

  const problems =
    response.action === 'accept' ? contentProblems(elicitation, response.content) : []

  return problems.length > 0
    ? inputRequiredError(server, 'invalid_responses', `${key}: ${problems.join('; ')}`)
    : Effect.succeed([elicitation.key, wireResponse(response)])
}

/**
 * Checks the host's decisions against the paused call and builds the wire `inputResponses`:
 * exactly one decision per elicitation; accepted content only names declared properties, holds
 * every required one, and matches each property's `type`. Fails with `McpInputRequiredError`
 * (`invalid_responses`) before anything is sent.
 */
export const toMcpInputResponses = (input: {
  readonly server: string
  readonly inputRequired: McpInputRequired
  readonly responses: McpElicitationResponses
}): Effect.Effect<Record<string, McpWireElicitResult>, McpInputRequiredError> =>
  Effect.gen(function* () {
    const keys = input.inputRequired.elicitations.map(elicitation => elicitation.key)
    const unknown = Object.keys(input.responses).filter(key => !keys.includes(key))

    if (unknown.length > 0) {
      return yield* inputRequiredError(
        input.server,
        'invalid_responses',
        unknown.map(key => `no elicitation ${JSON.stringify(key)}`).join('; ')
      )
    }

    const entries = yield* Effect.forEach(input.inputRequired.elicitations, elicitation =>
      wireInputResponse(
        input.server,
        elicitation,
        Object.hasOwn(input.responses, elicitation.key)
          ? input.responses[elicitation.key]
          : undefined
      )
    )

    return Object.fromEntries(entries)
  })
