import { Context, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorError } from './error.ts'
import type { ConnectorIntegration } from './integration.ts'

export const CredentialKind = Schema.Literals([
  'api_key',
  'bearer_token',
  'oauth',
  'username_password'
])
export type CredentialKind = typeof CredentialKind.Type

export class CredentialSlot extends Schema.Class<CredentialSlot>('CredentialSlot')({
  id: Schema.String,
  kind: CredentialKind,
  requiredScopes: Schema.optional(Schema.Array(Schema.String))
}) {}

export class CredentialBinding extends Schema.Class<CredentialBinding>('CredentialBinding')({
  slotId: Schema.String,
  credentialRef: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
}) {}

export class ApiKeyCredential extends Schema.Class<ApiKeyCredential>('ApiKeyCredential')({
  _tag: Schema.Literal('ApiKeyCredential'),
  key: Schema.String
}) {}

export class BearerTokenCredential extends Schema.Class<BearerTokenCredential>(
  'BearerTokenCredential'
)({
  _tag: Schema.Literal('BearerTokenCredential'),
  token: Schema.String,
  expiresAt: Schema.optional(Schema.Number)
}) {}

export class OAuthCredential extends Schema.Class<OAuthCredential>('OAuthCredential')({
  _tag: Schema.Literal('OAuthCredential'),
  provider: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  refreshToken: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String))
}) {}

export class UsernamePasswordCredential extends Schema.Class<UsernamePasswordCredential>(
  'UsernamePasswordCredential'
)({
  _tag: Schema.Literal('UsernamePasswordCredential'),
  username: Schema.String,
  password: Schema.String
}) {}

export const RuntimeCredential = Schema.Union([
  ApiKeyCredential,
  BearerTokenCredential,
  OAuthCredential,
  UsernamePasswordCredential
])
export type RuntimeCredential = typeof RuntimeCredential.Type

export type CredentialResolveRequest = {
  readonly integration: ConnectorIntegration
  readonly slot: CredentialSlot
  readonly binding: CredentialBinding
}

export type CredentialResolverApi = {
  readonly resolve: (
    request: CredentialResolveRequest
  ) => Effect.Effect<RuntimeCredential, ConnectorError>
}

export class CredentialResolver extends Context.Service<
  CredentialResolver,
  CredentialResolverApi
>()('@yolk-sdk/connectors/CredentialResolver') {}

export const makeCredentialBinding = (input: {
  readonly slotId: string
  readonly credentialRef: string
  readonly metadata?: Readonly<Record<string, unknown>>
}) => CredentialBinding.make(input)

export const findCredentialBinding = (integration: ConnectorIntegration, slot: CredentialSlot) =>
  Option.fromNullishOr(integration.credentialBindings.find(binding => binding.slotId === slot.id))

export const resolveCredential = (integration: ConnectorIntegration, slot: CredentialSlot) =>
  Effect.gen(function* () {
    const binding = findCredentialBinding(integration, slot)

    if (Option.isNone(binding)) {
      return yield* Effect.fail(
        new ConnectorError({
          cause: 'credential_binding_missing',
          message: `Missing credential binding for slot: ${slot.id}`,
          connectorId: integration.connectorId,
          slotId: slot.id
        })
      )
    }

    const resolver = yield* CredentialResolver
    return yield* resolver.resolve({ integration, slot, binding: binding.value })
  })
