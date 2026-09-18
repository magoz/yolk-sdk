import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  EmptyToolParams,
  toolJsonSchemaFromSchema,
  type ToolModule,
  type ToolRegistration
} from './registry.ts'
import {
  InputDescriptor,
  ToolDef,
  type InputContentFormatter,
  type InputToolHandler,
  type ToolCall,
  type ToolJsonSchema
} from '@yolk-sdk/agent/protocol'

type SyncSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }

export type MakeInputToolOptions<ResponseSchema extends SyncSchema> = {
  readonly name: string
  readonly description: string
  /** Model-facing call params (context for the request). Defaults to no params. */
  readonly callParameters?: SyncSchema
  /** Original server Effect Schema validating JSON user payloads. Never lowered for execution. */
  readonly response: ResponseSchema
  /** Stable app-owned renderer key. Defaults to 'custom'. */
  readonly renderer?: string
  readonly title?: string
  readonly inputDescription?: string
  /** Model-visible content projection from the original JSON payload. Defaults to JSON text. */
  readonly formatContent?: InputContentFormatter
}

export type InputToolModule<Context> = ToolModule<Context>

// Mirrors the submitted branch of formatInputResponseContent without fabricating ids.
const defaultInputContent = (input: { readonly name: string; readonly data: Schema.Json }) =>
  `User has provided input for "${input.name}": ${JSON.stringify(input.data)}. Continue with the user's input in mind.`

type InputToolDefFields = {
  name: string
  description: string
  parameters: ReturnType<typeof toolJsonSchemaFromSchema>
  input: InputDescriptor
}

type InputDescriptorFields = {
  kind: string
  title?: string
  description?: string
  schema?: ToolJsonSchema
}

const inputDescriptorFor = (options: {
  readonly renderer?: string
  readonly title?: string
  readonly inputDescription?: string
  readonly schema?: ToolJsonSchema
}) => {
  const fields: InputDescriptorFields = {
    kind: options.renderer ?? 'custom'
  }

  if (options.schema !== undefined) {
    fields.schema = options.schema
  }

  if (options.title !== undefined) {
    fields.title = options.title
  }

  if (options.inputDescription !== undefined) {
    fields.description = options.inputDescription
  }

  return InputDescriptor.make(fields)
}

/** Advertise-only input ToolDef without a server validator. Loop completions for such tools
 * fail closed (`unavailable`); pair with an inputs handler from a schema-backed registration.
 */
export const makeInputToolDef = (input: {
  readonly name: string
  readonly description: string
  readonly renderer?: string
  readonly title?: string
  readonly inputDescription?: string
  readonly schema?: ToolJsonSchema
  readonly callParameters?: ToolJsonSchema
}): ToolDef => {
  type AdvertiseInputDefFields = {
    name: string
    description: string
    parameters: ToolJsonSchema
    input: InputDescriptor
  }

  const descriptor = inputDescriptorFor({
    renderer: input.renderer,
    title: input.title,
    inputDescription: input.inputDescription,
    schema: input.schema
  })

  const fields: AdvertiseInputDefFields = {
    name: input.name,
    description: input.description,
    parameters: input.callParameters ?? toolJsonSchemaFromSchema(EmptyToolParams),
    input: descriptor
  }

  return ToolDef.make(fields)
}

/** Schema-backed generalized typed input registration. The original Effect schemas own
 * server validation; ToolDef carries a serializable descriptor only. Input tools never
 * take approval/background options, complete with validated user data without business side
 * effects, and fail closed on direct dispatch (they only complete through HITL resume).
 */
export const makeInputTool = <Context, ResponseSchema extends SyncSchema>(
  options: MakeInputToolOptions<ResponseSchema>
): ToolRegistration<Context> => {
  const callSchema = options.callParameters ?? EmptyToolParams

  const descriptor = inputDescriptorFor({
    renderer: options.renderer,
    title: options.title,
    inputDescription: options.inputDescription,
    schema: toolJsonSchemaFromSchema(options.response)
  })

  const def = ToolDef.make(
    (() => {
      const fields: InputToolDefFields = {
        name: options.name,
        description: options.description,
        parameters: toolJsonSchemaFromSchema(callSchema),
        input: descriptor
      }

      return fields
    })()
  )

  const formatContent: InputContentFormatter =
    options.formatContent ?? (input => defaultInputContent(input))

  const validateCall: InputToolHandler['validateCall'] = params =>
    Schema.decodeUnknownEffect(callSchema, { onExcessProperty: 'error' })(params).pipe(
      Effect.asVoid
    )

  const validateResponse: InputToolHandler['validateResponse'] = data =>
    Schema.decodeUnknownEffect(options.response, { onExcessProperty: 'error' })(data).pipe(
      Effect.asVoid
    )

  const execute = (call: ToolCall) =>
    Effect.fail(
      new ToolError({
        tool: options.name,
        cause: 'unavailable',
        message: `Input tool \"${options.name}\" for call ${call.id} requires user input and cannot execute directly.`
      })
    )

  return {
    def,
    access: 'read',
    validate: call =>
      validateCall(call.params).pipe(
        Effect.asVoid,
        Effect.mapError(
          error =>
            new ToolError({
              tool: options.name,
              cause: 'validation',
              message: `Invalid ${options.name} arguments: ${error.message}`
            })
        )
      ),
    execute: ({ call }) => execute(call),
    input: { validateCall, validateResponse, formatContent }
  }
}

export const makeInputToolModule = <Context, ResponseSchema extends SyncSchema>(
  options: MakeInputToolOptions<ResponseSchema>
): InputToolModule<Context> => ({
  id: options.name,
  tools: [makeInputTool(options)]
})
