import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { NullableBoolean, NullableString } from './fields.ts'
import { FortnoxProfileOAuthCredentialSlot } from './oauth.ts'
import { readFortnox } from './shared.ts'

// Fortnox "Me" resource: the user behind the access token. The OpenAPI schema marks no field
// required, so every field is optional and nullable.
export class FortnoxProfile extends Schema.Class<FortnoxProfile>('FortnoxProfile')({
  Id: NullableString,
  Name: NullableString,
  Email: NullableString,
  Locale: NullableString,
  SysAdmin: NullableBoolean
}) {}

export class FortnoxGetProfileInput extends Schema.Class<FortnoxGetProfileInput>(
  'FortnoxGetProfileInput'
)({}) {}

const MeResponse = Schema.Struct({ Me: FortnoxProfile })

export const fortnoxGetProfileAction = defineAction({
  id: 'fortnox.get_profile',
  description:
    'Read the Fortnox user behind the host credential (Id, Name, Email, Locale, SysAdmin). Describes the user, not the company; use fortnox.get_company_information for the company.',
  access: 'read',
  inputSchema: FortnoxGetProfileInput,
  outputSchema: FortnoxProfile,
  execute: ({ integration }) =>
    readFortnox(integration, FortnoxProfileOAuthCredentialSlot, 'me', MeResponse, value => value.Me)
})

export const fortnoxProfileActions = [fortnoxGetProfileAction] as const
