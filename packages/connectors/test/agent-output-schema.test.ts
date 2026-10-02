import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import { ActionResult, defineAction, defineConnector, makeIntegration } from '@yolk-sdk/connectors'
import { makeConnectorToolRegistration } from '@yolk-sdk/connectors/agent'
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
