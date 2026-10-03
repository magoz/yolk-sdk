import { Effect, Match, Predicate } from 'effect'
import type { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  makeTool,
  withToolArgumentsErrorHint,
  type ToolAccess,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import { ToolResult, type ToolExposure } from '@yolk-sdk/agent/protocol'
import type { ConnectorAction, ConnectorActionAccess } from './action.ts'
import type { Connector } from './connector.ts'
import type { ConnectorIntegration } from './integration.ts'
import type { ProviderFailure } from './result.ts'

export type ConnectorIntegrationResolver<Context> =
  | ConnectorIntegration
  | ((context: Context) => Effect.Effect<ConnectorIntegration, ToolError>)

export type ConnectorToolAccessResolver = ToolAccess | ((actionId: string) => ToolAccess)

/** The declared metadata of a connector action, as exposure resolvers see it. */
export type ConnectorToolActionInfo = Pick<ConnectorAction, 'id' | 'description' | 'access'>

/** Code mode exposure for connector tools: one value for every action, or per action (`action`
 * is `undefined` when the connector does not declare `actionId`). Omitted: the agent defaults
 * (`callableBy: 'all'`).
 */
export type ConnectorToolExposureResolver =
  | ToolExposure
  | ((actionId: string, action: ConnectorToolActionInfo | undefined) => ToolExposure)

export type MakeConnectorToolModuleOptions<Context, Env> = {
  readonly integration: ConnectorIntegrationResolver<Context>
  readonly layer: Layer.Layer<Env>
  readonly moduleId?: string
  readonly namePrefix?: string
  readonly access?: ConnectorToolAccessResolver
  /** Applied through `makeTool`'s `callableBy`/`discovery`; `resolveTools` still rejects invalid
   * combinations (for example `discovery` without `callableBy: 'codemode'`).
   */
  readonly exposure?: ConnectorToolExposureResolver
}

const resolveIntegration = <Context>(
  resolver: ConnectorIntegrationResolver<Context>,
  context: Context
) => {
  if (Predicate.isFunction(resolver)) {
    return resolver(context)
  }

  return Effect.succeed(resolver)
}

const resolveAccess = (
  resolver: ConnectorToolAccessResolver | undefined,
  actionId: string,
  actionAccess: ConnectorActionAccess | undefined
): ToolAccess => {
  if (Predicate.isFunction(resolver)) {
    return resolver(actionId)
  }

  return resolver ?? actionAccess ?? 'read'
}

const resolveExposure = (
  resolver: ConnectorToolExposureResolver | undefined,
  actionId: string,
  action: ConnectorToolActionInfo | undefined
): ToolExposure => (Predicate.isFunction(resolver) ? resolver(actionId, action) : (resolver ?? {}))

const failureContent = (failure: ProviderFailure) => `${failure.code}: ${failure.message}`

const successContent = (value: unknown) => {
  if (Predicate.isString(value)) {
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
    ...resolveExposure(options.exposure, actionId, action),
    name,
    description: action?.description ?? `Invoke connector action ${actionId}.`,
    parameters: action?.inputSchema ?? Schema.Unknown,
    output: action?.outputSchema,
    access: resolveAccess(options.access, actionId, action?.access),
    invalidParamsMessage: error =>
      withToolArgumentsErrorHint(
        `Invalid ${name} arguments: ${error instanceof Error ? error.message : String(error)}`,
        error
      ),
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
        Effect.map(result =>
          Match.value(result).pipe(
            Match.tag('Success', current =>
              ToolResult.make({
                toolCallId: call.id,
                content: successContent(current.value),
                structuredContent: current.value
              })
            ),
            Match.tag('Failure', current =>
              ToolResult.make({
                toolCallId: call.id,
                content: failureContent(current.error),
                isError: true,
                structuredContent: current.error
              })
            ),
            Match.exhaustive
          )
        ),
        Effect.mapError(
          error =>
            new ToolError({
              tool: name,
              message: error instanceof Error ? error.message : String(error),
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
