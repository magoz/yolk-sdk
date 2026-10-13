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

/**
 * Default bound, in UTF-8 bytes of JSON, applied separately to (1) the server-provided pause: the
 * `InputRequiredResult` and the decoded `McpInputRequired` without its tool definition, checked
 * after the response body is buffered (it bounds what is decoded and persisted, not what is
 * received); and (2) the carried tool definition, checked before the call. A persisted pause is
 * therefore at most about twice the bound.
 */
export const defaultMcpMaxInputRequiredBytes = 262_144

/** Most embedded input requests one `InputRequiredResult` may carry. */
export const mcpMaxInputRequests = 16

/**
 * Host opt-in to MCP form elicitation. Declare it only when the host can present a form with
 * accept, decline and cancel choices, persist the pending call, and resume it later.
 */
export type McpElicitationSupport = {
  readonly form: true
  /** Bound on one pause (JSON, UTF-8 bytes; a positive integer). Default `262_144`. */
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

/** A JSON Schema object as listed (kept as received). */
const ListedJsonSchema = Schema.Record(Schema.String, Schema.Json)

/**
 * The paused tool's listed definition: name, input and output schemas. A resume calls with it
 * instead of listing again (input schema for `x-mcp-header` mirroring, output schema for the
 * structured-output check). These are the only definition fields the pinned official client reads
 * from `toolDefinition` (`@modelcontextprotocol/client` 2.0.0); `annotations`, `_meta` and
 * `execution` (task support, which its 2026-07-28 codec deletes from listings) are not carried.
 */
export class McpPausedTool extends Schema.Class<McpPausedTool>('McpPausedTool')({
  name: Schema.String,
  inputSchema: ListedJsonSchema,
  outputSchema: Schema.optional(ListedJsonSchema)
}) {}

/**
 * A tool call the server paused for input: serializable, safe to persist. `requestState` is
 * opaque server state, echoed back byte-exact on resume; never inspect or change it. No
 * `elicitations` with a `requestState` is a load-shedding pause: resume with no responses.
 * The pause is bound to its call (`mcpToolName`, `argumentsDigest`): a resume with another tool
 * or other arguments is refused before sending. `tool` is the listed definition, absent when the
 * listing did not hold the tool.
 */
export class McpInputRequired extends Schema.Class<McpInputRequired>('McpInputRequired')({
  elicitations: Schema.Array(McpFormElicitation),
  requestState: Schema.optional(Schema.String),
  mcpToolName: Schema.String,
  /** `sha256:<hex>` of the canonical JSON (sorted keys) of the call's arguments. */
  argumentsDigest: Schema.String,
  tool: Schema.optional(McpPausedTool)
}) {}

/** What binds a pause to its call. */
export type McpPauseBinding = {
  readonly mcpToolName: string
  readonly argumentsDigest: string
  readonly tool: McpPausedTool | undefined
}

/** The JSON size of a carried tool definition, or `None` when it does not encode. */
export const mcpPausedToolBytes = (tool: McpPausedTool): Option.Option<number> =>
  Schema.encodeUnknownOption(Schema.fromJsonString(McpPausedTool))(tool).pipe(
    Option.map(json => new TextEncoder().encode(json).byteLength)
  )

/**
 * The host's `maxInputRequiredBytes` (default `defaultMcpMaxInputRequiredBytes`), or
 * `McpInputRequiredError` (`malformed`) when it is not a positive integer. The resumable call
 * functions check it before connecting.
 */
export const mcpMaxInputRequiredBytes = (input: {
  readonly server: string
  readonly elicitation: McpElicitationSupport | undefined
}): Effect.Effect<number, McpInputRequiredError> => {
  const maxBytes = input.elicitation?.maxInputRequiredBytes ?? defaultMcpMaxInputRequiredBytes

  return Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Effect.succeed(maxBytes)
    : Effect.fail(
        new McpInputRequiredError({
          server: input.server,
          reason: 'malformed',
          message: 'elicitation.maxInputRequiredBytes must be a positive integer'
        })
      )
}

const isJsonArray = Schema.is(Schema.Array(Schema.Json))

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const byKey = ([left]: readonly [string, Schema.Json], [right]: readonly [string, Schema.Json]) =>
  left < right ? -1 : 1

/** JSON with object keys sorted (recursively): equal values give equal text. */
export const canonicalMcpJson = (value: Schema.Json): string => {
  if (isJsonArray(value)) return `[${value.map(canonicalMcpJson).join(',')}]`

  if (isJsonObject(value)) {
    const members = Object.entries(value)
      .sort(byKey)
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalMcpJson(member)}`)

    return `{${members.join(',')}}`
  }

  return JSON.stringify(value)
}

const decodeJsonValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

/** `sha256:<hex>` of the canonical JSON of tool-call arguments (as they go on the wire). */
export const mcpArgumentsDigest = (args: unknown): Effect.Effect<string, Schema.SchemaError> =>
  encodeUnknownJson(args).pipe(
    Effect.flatMap(decodeJsonValue),
    Effect.flatMap(json =>
      Effect.promise(() =>
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalMcpJson(json)))
      )
    ),
    Effect.map(digest => `sha256:${hex(digest)}`)
  )

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
  readonly binding: McpPauseBinding
}): Effect.Effect<McpInputRequired, McpInputRequiredError> =>
  Effect.gen(function* () {
    const maxBytes = yield* mcpMaxInputRequiredBytes(input)

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

    const serverPause = McpInputRequired.make({
      elicitations,
      mcpToolName: input.binding.mcpToolName,
      argumentsDigest: input.binding.argumentsDigest,
      ...Option.match(Option.fromNullishOr(payload.requestState), {
        onNone: () => ({}),
        onSome: requestState => ({ requestState })
      })
    })

    // The carried tool definition is bounded on its own, before the call.
    const persisted = yield* Schema.encodeEffect(Schema.fromJsonString(McpInputRequired))(
      serverPause
    ).pipe(
      Effect.catch(() =>
        inputRequiredError(input.server, 'malformed', 'The pause does not encode as JSON')
      )
    )

    const persistedBytes = utf8Bytes(persisted)

    if (persistedBytes > maxBytes) {
      return yield* inputRequiredError(
        input.server,
        'too_large',
        `The pause is ${persistedBytes} bytes; the limit is ${maxBytes}`
      )
    }

    return Option.match(Option.fromNullishOr(input.binding.tool), {
      onNone: () => serverPause,
      onSome: tool =>
        McpInputRequired.make({
          elicitations: serverPause.elicitations,
          mcpToolName: serverPause.mcpToolName,
          argumentsDigest: serverPause.argumentsDigest,
          tool,
          ...Option.match(Option.fromNullishOr(serverPause.requestState), {
            onNone: () => ({}),
            onSome: requestState => ({ requestState })
          })
        })
    })
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

const JsonList = Schema.Array(Schema.Json)

const ConstOptions = Schema.Array(Schema.Struct({ const: Schema.Json }))

const ItemChoices = Schema.Struct({
  enum: Schema.optional(JsonList),
  anyOf: Schema.optional(ConstOptions)
})

/** Allowed values from `enum`, else from titled `oneOf`/`anyOf` options (`{ const, title }`). */
const allowedValues = (
  enumValue: Schema.Json | undefined,
  options: Schema.Json | undefined
): Option.Option<ReadonlyArray<Schema.Json>> =>
  Schema.decodeUnknownOption(JsonList)(enumValue).pipe(
    Option.orElse(() =>
      Schema.decodeUnknownOption(ConstOptions)(options).pipe(
        Option.map(choices => choices.map(choice => choice.const))
      )
    )
  )

const sameJson = (left: Schema.Json, right: Schema.Json) =>
  canonicalMcpJson(left) === canonicalMcpJson(right)

const isAllowed = (allowed: Option.Option<ReadonlyArray<Schema.Json>>, value: Schema.Json) =>
  Option.match(allowed, {
    onNone: () => true,
    onSome: values => values.some(candidate => sameJson(candidate, value))
  })

/**
 * `const`, `enum` (or titled `oneOf`), and for string lists `items.enum` (or `items.anyOf`). The
 * server validates again; this only catches a decision it would reject.
 */
const choiceProblems = (
  name: string,
  property: McpElicitationProperty,
  value: McpElicitationContentValue
) => {
  const constValue = property['const']

  const constProblem =
    constValue === undefined || sameJson(constValue, value)
      ? []
      : [`${name} must be ${canonicalMcpJson(constValue)}`]

  const enumProblem = isAllowed(allowedValues(property['enum'], property['oneOf']), value)
    ? []
    : [`${name} is not one of the allowed values`]

  const items = Schema.decodeUnknownOption(ItemChoices)(property['items'])

  const itemsAllowed = Option.flatMap(items, choices => allowedValues(choices.enum, choices.anyOf))

  const itemProblem =
    isStringArray(value) && value.some(item => !isAllowed(itemsAllowed, item))
      ? [`${name} holds a value that is not allowed`]
      : []

  return [...constProblem, ...enumProblem, ...itemProblem]
}

const decodeBound = Schema.decodeUnknownOption(Schema.Finite)

const FormatName = Schema.Literals(['email', 'uri', 'date', 'date-time'])

/** A real calendar date (`2026-02-30` is not). */
const isCalendarDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

const fullDate = /^(\d{4})-(\d{2})-(\d{2})$/

const dateTime =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/

const numberAt = (match: RegExpExecArray, group: number) => Number(match[group] ?? Number.NaN)

const isDate = (value: string) => {
  const match = fullDate.exec(value)

  return (
    match !== null && isCalendarDate(numberAt(match, 1), numberAt(match, 2), numberAt(match, 3))
  )
}

const isDateTime = (value: string) => {
  const match = dateTime.exec(value)

  if (match === null) return false

  const offsetHours = match[9] === undefined ? 0 : numberAt(match, 9)
  const offsetMinutes = match[10] === undefined ? 0 : numberAt(match, 10)

  return (
    isCalendarDate(numberAt(match, 1), numberAt(match, 2), numberAt(match, 3)) &&
    numberAt(match, 4) <= 23 &&
    numberAt(match, 5) <= 59 &&
    numberAt(match, 6) <= 60 &&
    offsetHours <= 23 &&
    offsetMinutes <= 59
  )
}

/** Syntax checks for the subset's formats (RFC 3339 dates; an absolute URI; `local@domain`). */
const matchesFormat = (format: typeof FormatName.Type, value: string) => {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+$/.test(value)
    case 'uri':
      return URL.canParse(value)
    case 'date':
      return isDate(value)
    case 'date-time':
      return isDateTime(value)
  }
}

const codePoints = (value: string) => Array.from(value).length

const outside = (count: number, min: Option.Option<number>, max: Option.Option<number>) =>
  (Option.isSome(min) && count < min.value) || (Option.isSome(max) && count > max.value)

/**
 * The bounds of the 2026-07-28 form-schema subset: string `minLength`/`maxLength` (in code
 * points) and `format`, number and integer `minimum`/`maximum` (inclusive; the subset has no
 * exclusive bounds), and string-list `minItems`/`maxItems`.
 */
const boundProblems = (
  name: string,
  property: McpElicitationProperty,
  value: McpElicitationContentValue
): ReadonlyArray<string> => {
  if (isString(value)) {
    const length = codePoints(value)

    const lengthProblem = outside(
      length,
      decodeBound(property['minLength']),
      decodeBound(property['maxLength'])
    )
      ? [`${name} has ${length} characters, outside minLength/maxLength`]
      : []

    const format = Schema.decodeUnknownOption(FormatName)(property['format'])

    const formatProblem =
      Option.isSome(format) && !matchesFormat(format.value, value)
        ? [`${name} is not a valid ${format.value}`]
        : []

    return [...lengthProblem, ...formatProblem]
  }

  if (isFiniteNumber(value)) {
    return outside(value, decodeBound(property['minimum']), decodeBound(property['maximum']))
      ? [`${name} is outside minimum/maximum`]
      : []
  }

  if (isStringArray(value)) {
    return outside(
      value.length,
      decodeBound(property['minItems']),
      decodeBound(property['maxItems'])
    )
      ? [`${name} has ${value.length} items, outside minItems/maxItems`]
      : []
  }

  return []
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

    if (property === undefined) return []

    return matchesPropertyType(property.type, value)
      ? [...choiceProblems(name, property, value), ...boundProblems(name, property, value)]
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
 * every required one, and matches each property's `type` (integer vs number), `const`, `enum` (or
 * titled `oneOf`), `minLength`/`maxLength`, `format`, `minimum`/`maximum`, and for string lists
 * `items.enum` (or `items.anyOf`) and `minItems`/`maxItems`. Fails with `McpInputRequiredError`
 * (`invalid_responses`) before anything is sent. The server still validates the decisions.
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
