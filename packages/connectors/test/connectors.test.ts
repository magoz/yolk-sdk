import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools } from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  ConnectorError,
  defineAction,
  defineConnector,
  makeIntegration
} from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { FigmaConnector } from '@yolk-sdk/connectors/figma'
import { GoogleConnector } from '@yolk-sdk/connectors/google'
import { LinkedInSearchConnector } from '@yolk-sdk/connectors/linkedin-search'
import { NotionConnector } from '@yolk-sdk/connectors/notion'
import { R2StorageConnector } from '@yolk-sdk/connectors/r2-storage'
import { TelegramConnector } from '@yolk-sdk/connectors/telegram'
import { TodoistConnector } from '@yolk-sdk/connectors/todoist'

const TestInput = Schema.Struct({ text: Schema.String })
const TestOutput = Schema.Struct({ value: Schema.String })

const testAction = defineAction({
  id: 'test.echo',
  description: 'Echo test action.',
  inputSchema: TestInput,
  outputSchema: TestOutput,
  execute: ({ input }) => Effect.succeed(ActionResult.success({ value: input.text }))
})

const failureAction = defineAction({
  id: 'test.fail',
  description: 'Return a provider failure.',
  inputSchema: Schema.Struct({}),
  outputSchema: TestOutput,
  execute: () => Effect.succeed(ActionResult.failure({ code: 'upstream_failed', message: 'Nope' }))
})

const TestConnector = defineConnector({
  id: 'test',
  actions: [testAction, failureAction]
})

const integration = makeIntegration({ connectorId: 'test' })

describe('@yolk-sdk/connectors', () => {
  it('imports public subpaths', async () => {
    const [root, agent, figma, google, linkedIn, notion, r2, telegram, todoist] = await Promise.all([
      import('@yolk-sdk/connectors'),
      import('@yolk-sdk/connectors/agent'),
      import('@yolk-sdk/connectors/figma'),
      import('@yolk-sdk/connectors/google'),
      import('@yolk-sdk/connectors/linkedin-search'),
      import('@yolk-sdk/connectors/notion'),
      import('@yolk-sdk/connectors/r2-storage'),
      import('@yolk-sdk/connectors/telegram'),
      import('@yolk-sdk/connectors/todoist')
    ])

    expect(root.defineConnector).toBeDefined()
    expect(agent.makeConnectorToolModule).toBeDefined()
    expect(figma.FigmaConnector).toBeDefined()
    expect(google.GoogleConnector).toBeDefined()
    expect(linkedIn.LinkedInSearchConnector).toBeDefined()
    expect(notion.NotionConnector).toBeDefined()
    expect(r2.R2StorageConnector).toBeDefined()
    expect(telegram.TelegramConnector).toBeDefined()
    expect(todoist.TodoistConnector).toBeDefined()
  })

  it('exposes provider action definitions', () => {
    expect(GoogleConnector.actions.map(action => action.id)).toEqual([
      'gmail.search',
      'gmail.get_message',
      'calendar.list_events',
      'calendar.create_event'
    ])
    expect(FigmaConnector.actions.map(action => action.id)).toEqual(['figma.mcp_auth'])
    expect(LinkedInSearchConnector.actions.map(action => action.id)).toEqual([
      'linkedin_search.search',
      'linkedin_search.profile',
      'linkedin_search.email'
    ])
    expect(NotionConnector.actions.map(action => action.id)).toEqual([
      'notion.search',
      'notion.get_page',
      'notion.create_page'
    ])
    expect(R2StorageConnector.actions.map(action => action.id)).toEqual(['r2_storage.upload_url'])
    expect(TelegramConnector.actions.map(action => action.id)).toEqual([
      'telegram.send_message',
      'telegram.validate'
    ])
    expect(TodoistConnector.actions.map(action => action.id)).toEqual([
      'todoist.list_tasks',
      'todoist.create_task',
      'todoist.close_task'
    ])
  })

  it.effect('invokes a typed connector action', () =>
    Effect.gen(function* () {
      const result = yield* TestConnector.invoke({
        integration,
        action: 'test.echo',
        input: { text: 'hello' }
      })

      expect(result).toEqual({ _tag: 'Success', value: { value: 'hello' } })
    })
  )

  it.effect('rejects connector mismatch', () =>
    Effect.gen(function* () {
      const result = yield* TestConnector.invoke({
        integration: makeIntegration({ connectorId: 'other' }),
        action: 'test.echo',
        input: { text: 'hello' }
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'connector_mismatch' }
      })
    })
  )

  it.effect('rejects invalid action input', () =>
    Effect.gen(function* () {
      const result = yield* TestConnector.invoke({
        integration,
        action: 'test.echo',
        input: { text: 123 }
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ConnectorError', cause: 'validation_failed' }
      })
    })
  )

  it.effect('adapts successful connector actions to agent tools', () =>
    Effect.gen(function* () {
      const toolModule = makeConnectorToolModule(TestConnector, {
        integration,
        layer: Layer.empty,
        access: action => action.includes('fail') ? 'write' : 'read'
      })
      const toolSet = yield* resolveTools([toolModule], {})
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: 'test.echo',
        params: { text: 'hi' }
      })

      expect(toolSet.metadata).toContainEqual({ moduleId: 'test', name: 'test.fail', access: 'write' })
      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: JSON.stringify({ value: 'hi' }),
        structuredContent: { value: 'hi' }
      })
    })
  )

  it.effect('adapts provider failures to error tool results', () =>
    Effect.gen(function* () {
      const toolModule = makeConnectorToolModule(TestConnector, {
        integration,
        layer: Layer.empty
      })
      const toolSet = yield* resolveTools([toolModule], {})
      const result = yield* toolSet.execute({ id: 'call_1', name: 'test.fail', params: {} })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'upstream_failed: Nope',
        isError: true,
        structuredContent: { code: 'upstream_failed', message: 'Nope' }
      })
    })
  )

  it('constructs typed errors', () => {
    expect(new ConnectorError({ cause: 'action_not_found', message: 'missing' })._tag).toBe(
      'ConnectorError'
    )
  })
})
