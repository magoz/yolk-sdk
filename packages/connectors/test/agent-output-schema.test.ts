import { Chunk, DateTime, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { resolveTools, toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  ProviderFailure,
  defineAction,
  defineConnector,
  makeIntegration
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule, makeConnectorToolRegistration } from '@yolk-sdk/connectors/agent'
import { AfloatConnector } from '@yolk-sdk/connectors/afloat'
import { DropboxConnector } from '@yolk-sdk/connectors/dropbox'
import { EmailConnector } from '@yolk-sdk/connectors/email'
import { FigmaConnector } from '@yolk-sdk/connectors/figma'
import { FortnoxConnector } from '@yolk-sdk/connectors/fortnox'
import { GithubConnector } from '@yolk-sdk/connectors/github'
import { GoogleConnector } from '@yolk-sdk/connectors/google'
import { LinkedInSearchConnector } from '@yolk-sdk/connectors/linkedin-search'
import { MicrosoftConnector } from '@yolk-sdk/connectors/microsoft'
import { NotionConnector } from '@yolk-sdk/connectors/notion'
import { R2StorageConnector } from '@yolk-sdk/connectors/r2-storage'
import { TelegramConnector } from '@yolk-sdk/connectors/telegram'
import { TodoistConnector } from '@yolk-sdk/connectors/todoist'

class EchoOutput extends Schema.Class<EchoOutput>('EchoOutput')({
  value: Schema.String,
  tags: Schema.Array(Schema.String)
}) {}

const echoAction = defineAction({
  id: 'test.echo',
  description: 'Echo test action.',
  inputSchema: Schema.Struct({ text: Schema.String }),
  outputSchema: EchoOutput,
  execute: ({ input }) =>
    Effect.succeed(ActionResult.success(EchoOutput.make({ value: input.text, tags: [] })))
})

const TestConnector = defineConnector({ id: 'test', actions: [echoAction] })

const options = { integration: makeIntegration({ connectorId: 'test' }), layer: Layer.empty }

type ActionOutputs = {
  readonly id: string
  readonly description?: string
  readonly actions: ReadonlyArray<{ readonly id: string; readonly outputSchema: Schema.Top }>
}

// Built-in connectors whose actions become agent tools; every output schema must lower the
// way makeConnectorToolRegistration lowers it (makeTool throws on unrepresentable schemas).
const connectors: ReadonlyArray<ActionOutputs> = [
  AfloatConnector,
  DropboxConnector,
  EmailConnector,
  FigmaConnector,
  FortnoxConnector,
  GithubConnector,
  GoogleConnector,
  LinkedInSearchConnector,
  MicrosoftConnector,
  NotionConnector,
  R2StorageConnector,
  TelegramConnector,
  TodoistConnector
]

describe('connector tool output schemas', () => {
  it('passes the action output schema through as ToolDef.outputSchema', () => {
    const registration = makeConnectorToolRegistration(TestConnector, 'test.echo', options)

    expect(registration.def.outputSchema).toEqual(toolJsonSchemaFromSchema(EchoOutput))
    expect(registration.def.outputSchema).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string' }, tags: { type: 'array' } },
      required: ['value', 'tags']
    })
    expect(registration.def.callableBy).toBeUndefined()
  })

  it('omits the output schema for unknown actions', () => {
    const registration = makeConnectorToolRegistration(TestConnector, 'test.missing', options)

    expect(Object.hasOwn(registration.def, 'outputSchema')).toBe(false)
  })

  it('lowers every built-in connector action output schema', () => {
    const lowered = connectors.flatMap(connector =>
      connector.actions.map(action => ({
        name: `${connector.id}.${action.id}`,
        schema: toolJsonSchemaFromSchema(action.outputSchema)
      }))
    )

    expect(lowered.length).toBeGreaterThan(100)

    for (const { name, schema } of lowered) {
      expect(schema, name).toBeDefined()
    }
  })
})

class ListOutput extends Schema.Class<ListOutput>('ListOutput')({
  items: Schema.Chunk(Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtc })),
  next: Schema.optionalKey(Schema.String)
}) {}

const listAction = defineAction({
  id: 'test.list',
  inputSchema: Schema.Struct({}),
  outputSchema: ListOutput,
  execute: () =>
    Effect.succeed(
      ActionResult.success(
        ListOutput.make({
          items: Chunk.make(
            { id: 'a', at: DateTime.makeUnsafe(0) },
            { id: 'b', at: DateTime.makeUnsafe(1_000) }
          )
        })
      )
    )
})

const ExtraKeyOutput = Schema.Struct({ id: Schema.String, meta: Schema.Unknown })

const extraKeyAction = defineAction({
  id: 'test.extra_key',
  inputSchema: Schema.Struct({}),
  outputSchema: ExtraKeyOutput,
  // The implementation returns a field the output schema does not declare.
  execute: () =>
    Effect.succeed(
      ActionResult.success({ id: 'a', meta: { raw: true }, internal: 'x' } satisfies {
        readonly id: string
        readonly meta: unknown
        readonly internal: string
      })
    )
})

const MismatchOutput = Schema.Struct({ count: Schema.Int })

const mismatchAction = defineAction({
  id: 'test.mismatch',
  inputSchema: Schema.Struct({}),
  outputSchema: MismatchOutput,
  // An implementation bug: the value does not satisfy the declared output schema.
  execute: () => Effect.succeed(ActionResult.success({ count: 1.5, secret: 'token-123' }))
})

const failingAction = (id: string, underlying: unknown) =>
  defineAction({
    id,
    inputSchema: Schema.Struct({}),
    outputSchema: Schema.Struct({}),
    execute: () =>
      Effect.succeed(
        ActionResult.failure({ code: 'upstream_failed', message: 'Nope', status: 502, underlying })
      )
  })

const EncodingConnector = defineConnector({
  id: 'encoding',
  description: 'Encoding test connector.',
  actions: [
    listAction,
    extraKeyAction,
    mismatchAction,
    failingAction('test.fail_json', { retryable: false }),
    failingAction('test.fail_error', new Error('wrapped'))
  ]
})

const encodingOptions = {
  integration: makeIntegration({ connectorId: 'encoding' }),
  layer: Layer.empty
}

const execute = (name: string) =>
  Effect.gen(function* () {
    const toolSet = yield* resolveTools(
      [makeConnectorToolModule(EncodingConnector, encodingOptions)],
      {}
    )

    return yield* toolSet.execute(ToolCall.make({ id: 'call_1', name, params: {} }))
  })

describe('connector tool results', () => {
  it.effect('returns the JSON encoding of the action output in structuredContent and text', () =>
    Effect.gen(function* () {
      const result = yield* execute('test.list')

      const encoded = {
        items: [
          { id: 'a', at: '1970-01-01T00:00:00.000Z' },
          { id: 'b', at: '1970-01-01T00:00:01.000Z' }
        ]
      }

      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toStrictEqual(encoded)
      expect(result.content).toBe(JSON.stringify(encoded))
      expect(JSON.stringify(result.structuredContent)).not.toContain('_id')
    })
  )

  it.effect('returns only the fields the output schema declares', () =>
    Effect.gen(function* () {
      const result = yield* execute('test.extra_key')

      // Undeclared keys are dropped; `Schema.Unknown` values pass through as JSON.
      expect(result.structuredContent).toStrictEqual({ id: 'a', meta: { raw: true } })
      expect(result.content).toBe('{"id":"a","meta":{"raw":true}}')
    })
  )

  it.effect('fails with a safe execution error when the output does not encode', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(execute('test.mismatch'))

      expect(failure).toMatchObject({
        _tag: 'ToolError',
        tool: 'test.mismatch',
        cause: 'execution',
        message: 'test.mismatch returned a result that does not match its output schema.'
      })
      expect(JSON.stringify(failure)).not.toContain('token-123')
    })
  )

  it.effect('encodes provider failures as JSON and drops a non-JSON underlying value', () =>
    Effect.gen(function* () {
      const json = yield* execute('test.fail_json')
      const wrapped = yield* execute('test.fail_error')

      expect(json).toMatchObject({ isError: true, content: 'upstream_failed: Nope' })
      expect(json.structuredContent).toStrictEqual({
        code: 'upstream_failed',
        message: 'Nope',
        status: 502,
        underlying: { retryable: false }
      })
      expect(json.structuredContent).not.toBeInstanceOf(ProviderFailure)
      expect(wrapped.structuredContent).toStrictEqual({
        code: 'upstream_failed',
        message: 'Nope',
        status: 502
      })
    })
  )
})

describe('connector tool modules', () => {
  it('uses the connector description as the module description unless overridden', () => {
    expect(makeConnectorToolModule(EncodingConnector, encodingOptions).description).toBe(
      'Encoding test connector.'
    )
    expect(
      makeConnectorToolModule(EncodingConnector, { ...encodingOptions, description: 'Override.' })
        .description
    ).toBe('Override.')
    expect(Object.hasOwn(makeConnectorToolModule(TestConnector, options), 'description')).toBe(
      false
    )
  })

  it('describes every built-in connector (its module description) and declares every output', () => {
    for (const connector of connectors) {
      expect(connector.description?.trim(), connector.id).toEqual(expect.stringMatching(/\S/))

      for (const action of connector.actions) {
        expect(Schema.isSchema(action.outputSchema), `${connector.id}.${action.id}`).toBe(true)
      }
    }
  })
})
