import { Effect, Match, Option, Predicate } from 'effect'
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
import {
  FilePart,
  inlineBase64AttachmentSource,
  TextPart,
  ToolResult,
  type ToolExposure
} from '@yolk-sdk/agent/protocol'
import type { ConnectorAction, ConnectorActionAccess } from './action.ts'
import type { Connector } from './connector.ts'
import type { ConnectorIntegration } from './integration.ts'
import { ProviderFailure } from './result.ts'

export type ConnectorIntegrationResolver<Context> =
  | ConnectorIntegration
  | ((context: Context) => Effect.Effect<ConnectorIntegration, ToolError>)

export type ConnectorToolAccessResolver = ToolAccess | ((actionId: string) => ToolAccess)

/** The declared metadata of a connector action, as exposure resolvers see it. */
export type ConnectorToolActionInfo = Pick<ConnectorAction, 'id' | 'description' | 'access'>

/** Tool exposure (`callableBy`/`discovery`/`loading`) for connector tools: one value for every
 * action, or per action (`action`
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
  /** `ToolModule.description` (shown by code mode under the namespace and indexed for tool
   * search). Default: the connector's `description`.
   */
  readonly description?: string
  readonly namePrefix?: string
  readonly access?: ConnectorToolAccessResolver
  /** Applied through `makeTool`'s `callableBy`/`discovery`/`loading`; `resolveTools` still rejects
   * invalid combinations (for example `discovery` without `callableBy: 'codemode'`).
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

const encodeProviderFailure = Schema.encodeUnknownEffect(Schema.toCodecJson(ProviderFailure))

type ProviderFailureSummary = {
  readonly code: string
  readonly message: string
  status?: number
  retryAfterMs?: number
}

const providerFailureSummary = (failure: ProviderFailure) => {
  const summary: ProviderFailureSummary = { code: failure.code, message: failure.message }

  if (failure.status !== undefined) summary.status = failure.status

  if (failure.retryAfterMs !== undefined) summary.retryAfterMs = failure.retryAfterMs

  return summary
}

/** The JSON encoding of a provider failure; a non-JSON `underlying` (for example a wrapped
 * error) is dropped. */
const failureStructuredContent = (failure: ProviderFailure) =>
  encodeProviderFailure(failure).pipe(
    Effect.catch(() =>
      encodeProviderFailure(ProviderFailure.make(providerFailureSummary(failure)))
    ),
    Effect.orElseSucceed(() => providerFailureSummary(failure))
  )

const successContent = (value: unknown) => {
  if (Predicate.isString(value)) {
    return value
  }

  return JSON.stringify(value)
}

const toolName = (prefix: string | undefined, actionId: string) =>
  prefix === undefined ? actionId : `${prefix}.${actionId}`

/**
 * One connector action as an agent tool. Success values are returned as the JSON encoding of the
 * action `outputSchema` (`Schema.toCodecJson`): `structuredContent` and the text content match the
 * declared `ToolDef.outputSchema` (a `Chunk` becomes an array, a `DateTime` an ISO string). A value
 * that does not encode fails the call with an `execution` `ToolError`. Provider failures become
 * error results whose `structuredContent` is the JSON encoding of the `ProviderFailure` (a
 * non-JSON `underlying` is dropped). Actions with `fileOutput` (ADR 0009) declare its byte-free
 * schema as the tool output and return their bytes as `FilePart`s after the text, which tool
 * resolution captures into `fileId`s.
 */
export const makeConnectorToolRegistration = <Context, Env = never, Error = never>(
  connector: Connector<Env, Error>,
  actionId: string,
  options: MakeConnectorToolModuleOptions<Context, Env>
): ToolRegistration<Context> => {
  const action = connector.actions.find(item => item.id === actionId)
  const name = toolName(options.namePrefix, actionId)

  const fileOutput = action?.fileOutput

  // Actions whose output carries file bytes declare their byte-free output (ADR 0009).
  const declaredOutput = fileOutput?.schema ?? action?.outputSchema

  const encode =
    declaredOutput === undefined
      ? undefined
      : Schema.encodeUnknownEffect(Schema.toCodecJson(declaredOutput))

  // Without a declared action there is no output schema to encode to: keep the value as is.
  const outputMismatch = () =>
    new ToolError({
      tool: name,
      message: `${name} returned a result that does not match its output schema.`,
      cause: 'execution'
    })

  const encodeOutput = (value: unknown): Effect.Effect<unknown, ToolError> =>
    encode === undefined
      ? Effect.succeed(value)
      : encode(value).pipe(Effect.mapError(outputMismatch))

  // The success result: the encoded output as text and `structuredContent`, then any file parts.
  const successResult = (callId: string, output: unknown) => {
    if (fileOutput === undefined) {
      return encodeOutput(output).pipe(
        Effect.map(value =>
          ToolResult.make({
            toolCallId: callId,
            content: successContent(value),
            structuredContent: value
          })
        )
      )
    }

    return Option.match(fileOutput.split(output), {
      onNone: () => Effect.fail(outputMismatch()),
      onSome: split =>
        encodeOutput(split.value).pipe(
          Effect.map(value =>
            ToolResult.make({
              toolCallId: callId,
              content: [
                TextPart.make({ text: successContent(value) }),
                ...split.files.map(file =>
                  file.filename === undefined
                    ? FilePart.make({
                        source: inlineBase64AttachmentSource(file.base64),
                        mimeType: file.mimeType
                      })
                    : FilePart.make({
                        source: inlineBase64AttachmentSource(file.base64),
                        mimeType: file.mimeType,
                        filename: file.filename
                      })
                )
              ],
              structuredContent: value
            })
          )
        )
    })
  }

  return makeTool({
    ...resolveExposure(options.exposure, actionId, action),
    name,
    description: action?.description ?? `Invoke connector action ${actionId}.`,
    parameters: action?.inputSchema ?? Schema.Unknown,
    output: declaredOutput,
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
        Effect.mapError(
          error =>
            new ToolError({
              tool: name,
              message: error instanceof Error ? error.message : String(error),
              cause: 'execution'
            })
        ),
        Effect.flatMap(result =>
          Match.value(result).pipe(
            Match.tag('Success', current => successResult(call.id, current.value)),
            Match.tag('Failure', current =>
              failureStructuredContent(current.error).pipe(
                Effect.map(structuredContent =>
                  ToolResult.make({
                    toolCallId: call.id,
                    content: failureContent(current.error),
                    isError: true,
                    structuredContent
                  })
                )
              )
            ),
            Match.exhaustive
          )
        )
      )
  })
}

/** All actions of a connector as one tool module (`id` defaults to the connector id,
 * `description` to the connector description). */
export const makeConnectorToolModule = <Context, Env = never, Error = never>(
  connector: Connector<Env, Error>,
  options: MakeConnectorToolModuleOptions<Context, Env>
): ToolModule<Context> => {
  const description = options.description ?? connector.description

  const tools = connector.actions.map(action =>
    makeConnectorToolRegistration(connector, action.id, options)
  )

  const id = options.moduleId ?? connector.id

  return description === undefined ? { id, tools } : { id, description, tools }
}
