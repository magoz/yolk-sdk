import { Effect, Option, Predicate } from 'effect'
import {
  VoiceToolDispatch,
  backgroundVoiceUnsupportedMessage
} from '../background-execution-internal.ts'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  BackgroundToolAccepted,
  ToolCall,
  ToolDef,
  decodeBackgroundToolInput,
  isToolJsonSchemaObject,
  makeBackgroundToolAcceptedResult,
  type ToolJsonSchema,
  type ToolResult
} from '@yolk-sdk/agent/protocol'

/** Supplying this seam asserts a real lifecycle owner, not a request-scoped detached task.
 * accept must atomically admit/idempotently recover the exact request before returning a receipt.
 * Hosts own authorization, scope, cancellation, terminal result/usage storage and delivery.
 * No executable closure is passed across this durable boundary.
 */
export type BackgroundToolHost<Context> = {
  readonly accept: (input: {
    /** Validated business call: original tool name/id with control fields stripped. */
    readonly call: ToolCall
    /** Exact model request including the execution envelope, for audit/binding. */
    readonly request: ToolCall
    readonly context: Context
  }) => Effect.Effect<BackgroundToolAccepted, ToolError>
}

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

// Only traverse JSON Schema positions. Keywords in defaults/examples/const/enum are business data.
const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas'
])

const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

const schemaValues = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema'
])

const unsupportedResourceKeywords = new Set([
  '$id',
  'id',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef'
])

/** Narrow relocation contract, not a reference compiler: only document-root $defs pointers
 * survive hoisting. Resource boundaries and other reference forms must fail activation.
 */
export const unsupportedBackgroundSchema = (schema: Schema.Json): string | undefined => {
  if (!isJsonObject(schema)) return undefined

  for (const [key, value] of Object.entries(schema)) {
    if (unsupportedResourceKeywords.has(key)) return key

    if (key === '$ref' && (!Predicate.isString(value) || !/^#\/\$defs\/[^#%]+$/.test(value))) {
      return '$ref (only #/$defs/... pointers are supported)'
    }

    const children =
      schemaMaps.has(key) || key === 'dependencies'
        ? isJsonObject(value)
          ? Object.values(value)
          : []
        : schemaArrays.has(key) || (key === 'items' && Array.isArray(value))
          ? Array.isArray(value)
            ? value
            : []
          : schemaValues.has(key)
            ? [value]
            : []

    for (const child of children) {
      const unsupported = unsupportedBackgroundSchema(child)

      if (unsupported !== undefined) return unsupported
    }
  }

  return undefined
}

/** Activated advertisement for schemas checked by unsupportedBackgroundSchema:
 * original parameters nest under `arguments`; document-root `$defs` remain at the root.
 */
export const backgroundToolDef = (def: ToolDef): ToolDef => {
  let argumentsSchema: ToolJsonSchema = def.parameters
  let $defs: Schema.Json | undefined

  if (isToolJsonSchemaObject(def.parameters)) {
    const { $defs: definitions, ...rest } = def.parameters
    argumentsSchema = rest
    $defs = definitions
  }

  return ToolDef.make({
    ...def,
    execution: 'background-v1',
    parameters: (() => {
      type BackgroundToolParametersFields = {
        type: 'object'
        properties: {
          execution: { type: 'string'; enum: ['foreground', 'background'] }
          arguments: ToolJsonSchema
        }
        required: ['execution', 'arguments']
        additionalProperties: false
        $defs?: Schema.Json
      }

      const fields: BackgroundToolParametersFields = {
        type: 'object',
        properties: {
          execution: { type: 'string', enum: ['foreground', 'background'] },
          arguments: argumentsSchema
        },
        required: ['execution', 'arguments'],
        additionalProperties: false
      }

      if ($defs !== undefined) {
        fields.$defs = $defs
      }

      return fields
    })()
  })
}

export const executeBackgroundTool = <Context>(input: {
  readonly request: ToolCall
  readonly context: Context
  readonly host: BackgroundToolHost<Context>
  readonly validate: (call: ToolCall) => Effect.Effect<void | ToolResult, ToolError>
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
}): Effect.Effect<ToolResult, ToolError> =>
  Effect.gen(function* () {
    if (yield* VoiceToolDispatch) {
      return yield* Effect.fail(
        new ToolError({
          tool: input.request.name,
          cause: 'denied',
          message: backgroundVoiceUnsupportedMessage
        })
      )
    }

    const envelope = yield* Option.match(decodeBackgroundToolInput(input.request.params), {
      onNone: () =>
        Effect.fail(
          new ToolError({
            tool: input.request.name,
            cause: 'validation',
            message: 'Expected exactly execution (foreground or background) and arguments.'
          })
        ),
      onSome: Effect.succeed
    })

    const call = ToolCall.make({ ...input.request, params: envelope.arguments })
    // Decode business arguments before admission, without running business effects.
    const invalidResult = yield* input.validate(call)

    if (invalidResult !== undefined) return invalidResult

    if (envelope.execution === 'foreground') return yield* input.execute(call)

    const receipt = yield* input.host.accept({
      call,
      request: input.request,
      context: input.context
    })

    const acceptance = yield* Schema.decodeUnknownEffect(BackgroundToolAccepted)(receipt).pipe(
      Effect.mapError(
        () =>
          new ToolError({
            tool: call.name,
            cause: 'execution',
            message: 'Background host returned an invalid admission receipt.'
          })
      )
    )

    return makeBackgroundToolAcceptedResult({ toolCallId: call.id, acceptance })
  })
