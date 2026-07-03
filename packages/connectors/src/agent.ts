import { Effect } from 'effect'
import type { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  makeTool,
  type ToolAccess,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import type { Connector } from './connector.ts'
import type { ConnectorIntegration } from './integration.ts'
import type { ProviderFailure } from './result.ts'

export type ConnectorIntegrationResolver<Context> =
  | ConnectorIntegration
  | ((context: Context) => Effect.Effect<ConnectorIntegration, ToolError>)

export type ConnectorToolAccessResolver = ToolAccess | ((actionId: string) => ToolAccess)

export type MakeConnectorToolModuleOptions<Context, Env> = {
  readonly integration: ConnectorIntegrationResolver<Context>
  readonly layer: Layer.Layer<Env>
  readonly moduleId?: string
  readonly namePrefix?: string
  readonly access?: ConnectorToolAccessResolver
}

const resolveIntegration = <Context>(
  resolver: ConnectorIntegrationResolver<Context>,
  context: Context
) => {
  if (typeof resolver === 'function') {
    return resolver(context)
  }

  return Effect.succeed(resolver)
}

const resolveAccess = (
  resolver: ConnectorToolAccessResolver | undefined,
  actionId: string
): ToolAccess => {
  if (typeof resolver === 'function') {
    return resolver(actionId)
  }

  return resolver ?? 'read'
}

const unknownToMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const failureContent = (failure: ProviderFailure) => `${failure.code}: ${failure.message}`

const successContent = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }

  return JSON.stringify(value)
}

const toolName = (prefix: string | undefined, actionId: string) =>
  prefix === undefined ? actionId : `${prefix}.${actionId}`

export const makeConnectorToolRegistration = <Context, Env = never, Error = never>(
  connector: Connector<Env, Error>,
  actionId: string,
  options: MakeConnectorToolModuleOptions<Context, Env>
): ToolRegistration<Context> => {
  const action = connector.actions.find(item => item.id === actionId)
  const name = toolName(options.namePrefix, actionId)

  return makeTool({
    name,
    description: action?.description ?? `Invoke connector action ${actionId}.`,
    parameters: action?.inputSchema ?? Schema.Unknown,
    access: resolveAccess(options.access, actionId),
    invalidParamsMessage: error => `Invalid ${name} arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      resolveIntegration(options.integration, context).pipe(
        Effect.flatMap(integration =>
          connector
            .invoke({
              integration,
              action: actionId,
              input: params
            })
            .pipe(Effect.provide(options.layer))
        ),
        Effect.map(result => {
          switch (result._tag) {
            case 'Success':
              return ToolResult.make({
                toolCallId: call.id,
                content: successContent(result.value),
                structuredContent: result.value
              })
            case 'Failure':
              return ToolResult.make({
                toolCallId: call.id,
                content: failureContent(result.error),
                isError: true,
                structuredContent: result.error
              })
          }
        }),
        Effect.mapError(
          error =>
            new ToolError({
              tool: name,
              message: unknownToMessage(error),
              cause: 'execution'
            })
        )
      )
  })
}

export const makeConnectorToolModule = <Context, Env = never, Error = never>(
  connector: Connector<Env, Error>,
  options: MakeConnectorToolModuleOptions<Context, Env>
): ToolModule<Context> => ({
  id: options.moduleId ?? connector.id,
  tools: connector.actions.map(action =>
    makeConnectorToolRegistration(connector, action.id, options)
  )
})
