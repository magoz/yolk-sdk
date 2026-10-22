import { readFileSync } from 'node:fs'
import { Effect, Layer, Predicate, Schema, type Context } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ConnectorError,
  ConnectorHttpClient,
  CredentialResolver,
  makeIntegration,
  type Connector
} from '@yolk-sdk/connectors'
import { makeConnectorToolRegistration } from '@yolk-sdk/connectors/agent'
import { AfloatConnector } from '@yolk-sdk/connectors/afloat'
import { DropboxConnector } from '@yolk-sdk/connectors/dropbox'
import { EmailClient, EmailConnector } from '@yolk-sdk/connectors/email'
import { FigmaConnector } from '@yolk-sdk/connectors/figma'
import { FortnoxConnector } from '@yolk-sdk/connectors/fortnox'
import { GithubConnector } from '@yolk-sdk/connectors/github'
import { GoogleConnector } from '@yolk-sdk/connectors/google'
import { LinkedInSearchConnector } from '@yolk-sdk/connectors/linkedin-search'
import { MicrosoftConnector } from '@yolk-sdk/connectors/microsoft'
import { NotionConnector } from '@yolk-sdk/connectors/notion'
import { R2Presigner, R2StorageConnector } from '@yolk-sdk/connectors/r2-storage'
import { TelegramConnector } from '@yolk-sdk/connectors/telegram'
import { TodoistConnector } from '@yolk-sdk/connectors/todoist'

// Lowering a tool never touches the host; these services fail if anything invokes them.
const unusedHost = Layer.mergeAll(
  Layer.succeed(CredentialResolver, {
    resolve: () =>
      Effect.fail(
        new ConnectorError({ cause: 'credential_missing', message: 'Unexpected credential' })
      )
  }),
  Layer.succeed(ConnectorHttpClient, {
    request: () =>
      Effect.fail(new ConnectorError({ cause: 'transport_failed', message: 'Unexpected request' }))
  })
)

/** A host layer for services lowering never uses: building it would fail the test. */
const neverBuilt = <I, S>(service: Context.Key<I, S>) =>
  Layer.effect(service, Effect.die(new Error('Tool lowering built a connector host layer')))

const emailHost = Layer.merge(unusedHost, neverBuilt(EmailClient))

const r2Host = Layer.merge(unusedHost, neverBuilt(R2Presigner))

/** Every connector's lowered tool parameters, keyed by its package subpath. */
const parametersOf = <Env, E>(
  connectorId: string,
  connector: Connector<Env, E>,
  layer: Layer.Layer<Env>
) =>
  connector.actions.map(action => ({
    actionId: action.id,
    parameters: makeConnectorToolRegistration(connector, action.id, {
      integration: makeIntegration({ connectorId }),
      layer
    }).def.parameters
  }))

const connectors: ReadonlyArray<
  readonly [string, () => ReadonlyArray<{ actionId: string; parameters: unknown }>]
> = [
  ['afloat', () => parametersOf('afloat', AfloatConnector, unusedHost)],
  ['dropbox', () => parametersOf('dropbox', DropboxConnector, unusedHost)],
  ['email', () => parametersOf('email', EmailConnector, emailHost)],
  ['figma', () => parametersOf('figma', FigmaConnector, unusedHost)],
  ['fortnox', () => parametersOf('fortnox', FortnoxConnector, unusedHost)],
  ['github', () => parametersOf('github', GithubConnector, unusedHost)],
  ['google', () => parametersOf('google', GoogleConnector, unusedHost)],
  ['linkedin-search', () => parametersOf('linkedin-search', LinkedInSearchConnector, unusedHost)],
  ['microsoft', () => parametersOf('microsoft', MicrosoftConnector, unusedHost)],
  ['notion', () => parametersOf('notion', NotionConnector, unusedHost)],
  ['r2-storage', () => parametersOf('r2-storage', R2StorageConnector, r2Host)],
  ['telegram', () => parametersOf('telegram', TelegramConnector, unusedHost)],
  ['todoist', () => parametersOf('todoist', TodoistConnector, unusedHost)]
]

const isJsonArray = Schema.is(Schema.Array(Schema.Json))

const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))

const nonFiniteLiterals = ['NaN', 'Infinity', '-Infinity']

/** JSON Pointers of every schema that lists a non-finite number literal in its `enum`. */
const nonFiniteEnums = (node: Schema.Json, path: string): ReadonlyArray<string> => {
  if (isJsonArray(node))
    return node.flatMap((child, index) => nonFiniteEnums(child, `${path}/${index}`))

  if (!isJsonRecord(node)) return []

  const own =
    isJsonArray(node.enum) &&
    node.enum.some(value => Predicate.isString(value) && nonFiniteLiterals.includes(value))
      ? [path]
      : []

  return [
    ...own,
    ...Object.entries(node).flatMap(([key, value]) => nonFiniteEnums(value, `${path}/${key}`))
  ]
}

const subpathOf = /^\.\/([a-z0-9-]+)$/u

describe('connector tool input numbers', () => {
  it.effect('covers every connector the package exports', () =>
    Effect.gen(function* () {
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Json) }))
      )(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

      const exported = Object.keys(manifest.exports).flatMap(key => {
        const match = subpathOf.exec(key)

        return match?.[1] === undefined || ['agent', 'conformance'].includes(match[1])
          ? []
          : [match[1]]
      })

      expect([...exported].sort()).toEqual(connectors.map(([subpath]) => subpath).sort())
    })
  )

  // A bare `Schema.Number` lowers to `number | "NaN" | "Infinity" | "-Infinity"`, but decoded
  // tool arguments reject non-finite numbers: models must not be offered them.
  it.effect('advertises only finite numbers in tool parameters', () =>
    Effect.gen(function* () {
      const tools = connectors.flatMap(([, toolsOf]) => toolsOf())

      const offenders = yield* Effect.forEach(tools, ({ actionId, parameters }) =>
        Schema.decodeUnknownEffect(Schema.Json)(parameters).pipe(
          Effect.map(json => nonFiniteEnums(json, '').map(path => `${actionId} ${path}`))
        )
      )

      expect(offenders.flat()).toEqual([])
    })
  )
})
