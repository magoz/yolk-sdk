import { Config, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { McpSecurityPolicy, McpServerConfig } from '@yolk/mcp'

const McpRemoteServerConfigSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal('remote'),
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean)
})

const McpLocalServerConfigSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal('local'),
  command: Schema.Array(Schema.String),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean)
})

const McpServerConfigSchema = Schema.Union([
  McpRemoteServerConfigSchema,
  McpLocalServerConfigSchema
])
const McpServerConfigsSchema = Schema.Array(McpServerConfigSchema)

class McpConfigError extends Schema.TaggedErrorClass<McpConfigError>()('McpConfigError', {
  message: Schema.String
}) {}

const decodeMcpServerConfigs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(McpServerConfigsSchema)
)

const optionalBoolean = (name: string) =>
  Effect.gen(function* () {
    const option = yield* Config.option(Config.boolean(name))
    return Option.getOrElse(option, () => false)
  }).pipe(Effect.catch(() => Effect.succeed(false)))

export const loadMcpServerConfigs = (): Effect.Effect<
  ReadonlyArray<McpServerConfig>,
  McpConfigError
> =>
  Effect.gen(function* () {
    const raw = yield* Config.option(Config.string('YOLK_MCP_SERVERS'))
    if (Option.isNone(raw)) {
      return []
    }

    return yield* decodeMcpServerConfigs(raw.value).pipe(
      Effect.mapError(
        error => new McpConfigError({ message: `Invalid YOLK_MCP_SERVERS: ${String(error)}` })
      )
    )
  }).pipe(
    Effect.catch(error =>
      Effect.fail(new McpConfigError({ message: `Could not load MCP config: ${String(error)}` }))
    )
  )

export const loadMcpSecurityPolicy = (): Effect.Effect<McpSecurityPolicy> =>
  Effect.gen(function* () {
    const allowLocalServers = yield* optionalBoolean('YOLK_MCP_LOCAL_ENABLED')
    const allowDevHttpLocalhost = yield* optionalBoolean('YOLK_MCP_DEV_HTTP_LOCALHOST')

    return { allowLocalServers, allowDevHttpLocalhost }
  })
