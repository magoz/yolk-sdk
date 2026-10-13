// Fortnox `settings` scope, part 1: company settings, locked period, predefined accounts, and
// labels. Sources: Fortnox OpenAPI (https://apps.fortnox.se/apidocs) and the archived resource
// pages (developer.fortnox.se/documentation/resources/{company-settings,locked-period,
// predefined-accounts,labels}).
import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import {
  AccountNumber,
  NonEmptyString,
  NullableBoolean,
  NullableInt,
  NullableString,
  closedInput
} from './fields.ts'
import { FortnoxSettingsOAuthCredentialSlot } from './oauth.ts'
import { FortnoxMetaInformation, deleteFortnox, readFortnox, writeFortnox } from './shared.ts'

export const FortnoxLabelId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })
).pipe(Schema.brand('FortnoxLabelId'))

export type FortnoxLabelId = typeof FortnoxLabelId.Type

// Fortnox docs: predefined account names are upper case in the URL (e.g. SALES, SALES2,
// SALES_25_SE, OUTVAT_MP1).
export const FortnoxPredefinedAccountName = Schema.Trimmed.check(
  Schema.isPattern(/^[A-Z0-9_]+$/u)
).pipe(Schema.brand('FortnoxPredefinedAccountName'))

export type FortnoxPredefinedAccountName = typeof FortnoxPredefinedAccountName.Type

// Bounded read model. Omitted: DatabaseNumber (documented as string, example sends a number),
// Fax, and ContactFirstName/ContactLastName.
export class FortnoxCompanySettings extends Schema.Class<FortnoxCompanySettings>(
  'FortnoxCompanySettings'
)({
  Name: NullableString,
  OrganizationNumber: NullableString,
  Address: NullableString,
  ZipCode: NullableString,
  City: NullableString,
  Country: NullableString,
  CountryCode: NullableString,
  VisitName: NullableString,
  VisitAddress: NullableString,
  VisitZipCode: NullableString,
  VisitCity: NullableString,
  VisitCountry: NullableString,
  VisitCountryCode: NullableString,
  Email: NullableString,
  Phone1: NullableString,
  Phone2: NullableString,
  WWW: NullableString,
  BG: NullableString,
  PG: NullableString,
  IBAN: NullableString,
  BIC: NullableString,
  VATNumber: NullableString,
  TaxEnabled: NullableBoolean,
  Domicile: NullableString,
  BranchCode: NullableString
}) {}

export class FortnoxLockedPeriod extends Schema.Class<FortnoxLockedPeriod>('FortnoxLockedPeriod')({
  EndDate: NullableString
}) {}

export class FortnoxPredefinedAccount extends Schema.Class<FortnoxPredefinedAccount>(
  'FortnoxPredefinedAccount'
)({
  Name: FortnoxPredefinedAccountName,
  Account: NullableInt
}) {}

export class FortnoxLabel extends Schema.Class<FortnoxLabel>('FortnoxLabel')({
  Id: FortnoxLabelId,
  Description: NullableString
}) {}

export class FortnoxGetCompanySettingsInput extends Schema.Class<FortnoxGetCompanySettingsInput>(
  'FortnoxGetCompanySettingsInput'
)({}) {}

export class FortnoxGetLockedPeriodInput extends Schema.Class<FortnoxGetLockedPeriodInput>(
  'FortnoxGetLockedPeriodInput'
)({}) {}

export class FortnoxListPredefinedAccountsInput extends Schema.Class<FortnoxListPredefinedAccountsInput>(
  'FortnoxListPredefinedAccountsInput'
)({}) {}

export class FortnoxListPredefinedAccountsOutput extends Schema.Class<FortnoxListPredefinedAccountsOutput>(
  'FortnoxListPredefinedAccountsOutput'
)({ predefinedAccounts: Schema.Chunk(FortnoxPredefinedAccount) }) {}

export class FortnoxGetPredefinedAccountInput extends Schema.Class<FortnoxGetPredefinedAccountInput>(
  'FortnoxGetPredefinedAccountInput'
)({ name: FortnoxPredefinedAccountName }) {}

export class FortnoxUpdatePredefinedAccountInput extends Schema.Class<FortnoxUpdatePredefinedAccountInput>(
  'FortnoxUpdatePredefinedAccountInput'
)({ Name: FortnoxPredefinedAccountName, Account: AccountNumber }) {}

export class FortnoxListLabelsInput extends Schema.Class<FortnoxListLabelsInput>(
  'FortnoxListLabelsInput'
)({}) {}

export class FortnoxListLabelsOutput extends Schema.Class<FortnoxListLabelsOutput>(
  'FortnoxListLabelsOutput'
)({ labels: Schema.Chunk(FortnoxLabel) }) {}

// Fortnox docs: Description is required, 1-25 characters.
const LabelDescription = NonEmptyString.check(Schema.isMaxLength(25))

export class FortnoxCreateLabelInput extends Schema.Class<FortnoxCreateLabelInput>(
  'FortnoxCreateLabelInput'
)({ Description: LabelDescription }) {}

export class FortnoxUpdateLabelInput extends Schema.Class<FortnoxUpdateLabelInput>(
  'FortnoxUpdateLabelInput'
)({ Id: FortnoxLabelId, Description: LabelDescription }) {}

export class FortnoxDeleteLabelInput extends Schema.Class<FortnoxDeleteLabelInput>(
  'FortnoxDeleteLabelInput'
)({ labelId: FortnoxLabelId }) {}

export class FortnoxDeleteLabelOutput extends Schema.Class<FortnoxDeleteLabelOutput>(
  'FortnoxDeleteLabelOutput'
)({ labelId: FortnoxLabelId, deleted: Schema.Literal(true) }) {}

// The Fortnox OpenAPI documents no MetaInformation and no paging parameters for labels or
// predefined accounts (the legacy predefined-accounts page showed one page of 33). Accept an
// absent MetaInformation, but reject a response announcing more pages instead of truncating.
const singlePage = Schema.makeFilter<{
  readonly MetaInformation?: typeof FortnoxMetaInformation.Type
}>(value =>
  value.MetaInformation !== undefined && value.MetaInformation['@TotalPages'] > 1
    ? {
        path: ['MetaInformation', '@TotalPages'],
        issue: 'Fortnox announced more than one page for an unpaginated list'
      }
    : undefined
)

const PredefinedAccountsResponse = Schema.Struct({
  PreDefinedAccounts: Schema.Array(FortnoxPredefinedAccount),
  MetaInformation: Schema.optional(FortnoxMetaInformation)
}).check(singlePage)

// Fortnox spells the envelope `PreDefinedAccount` in requests and responses.
const PredefinedAccountResponse = Schema.Struct({ PreDefinedAccount: FortnoxPredefinedAccount })

const LabelsResponse = Schema.Struct({
  Labels: Schema.Array(FortnoxLabel),
  MetaInformation: Schema.optional(FortnoxMetaInformation)
}).check(singlePage)

const LabelResponse = Schema.Struct({ Label: FortnoxLabel })

export const fortnoxGetCompanySettingsAction = defineAction({
  id: 'fortnox.get_company_settings',
  description:
    'Read the Fortnox company settings (name, addresses, contact, bank giro/plus giro/IBAN/BIC, VAT number, TaxEnabled). Read-only in Fortnox.',
  access: 'read',
  inputSchema: FortnoxGetCompanySettingsInput,
  outputSchema: FortnoxCompanySettings,
  execute: ({ integration }) =>
    readFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      'settings/company',
      Schema.Struct({ CompanySettings: FortnoxCompanySettings }),
      value => value.CompanySettings
    )
})

export const fortnoxGetLockedPeriodAction = defineAction({
  id: 'fortnox.get_locked_period',
  description:
    'Read the Fortnox locked bookkeeping period. EndDate is the last locked date; when Fortnox returns no date, no period is locked. Read-only.',
  access: 'read',
  inputSchema: FortnoxGetLockedPeriodInput,
  outputSchema: FortnoxLockedPeriod,
  execute: ({ integration }) =>
    readFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      'settings/lockedperiod',
      Schema.Struct({ LockedPeriod: FortnoxLockedPeriod }),
      value => value.LockedPeriod
    )
})

export const fortnoxListPredefinedAccountsAction = defineAction({
  id: 'fortnox.list_predefined_accounts',
  description:
    'List all Fortnox predefined accounts: the default bookkeeping account (Account) Fortnox uses for each account type (Name, e.g. SALES, SALES2, BG). Not paginated.',
  access: 'read',
  inputSchema: FortnoxListPredefinedAccountsInput,
  outputSchema: FortnoxListPredefinedAccountsOutput,
  execute: ({ integration }) =>
    readFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      'predefinedaccounts',
      PredefinedAccountsResponse,
      value =>
        FortnoxListPredefinedAccountsOutput.make({
          predefinedAccounts: Chunk.fromIterable(value.PreDefinedAccounts)
        })
    )
})

export const fortnoxGetPredefinedAccountAction = defineAction({
  id: 'fortnox.get_predefined_account',
  description:
    'Read one Fortnox predefined account by its upper-case Name (e.g. SALES; the services variant ends with 2, e.g. SALES2).',
  access: 'read',
  inputSchema: FortnoxGetPredefinedAccountInput,
  outputSchema: FortnoxPredefinedAccount,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      `predefinedaccounts/${encodeURIComponent(input.name)}`,
      PredefinedAccountResponse,
      value => value.PreDefinedAccount
    )
})

export const fortnoxUpdatePredefinedAccountAction = defineAction({
  id: 'fortnox.update_predefined_account',
  description:
    'Change which four-digit bookkeeping Account Fortnox uses by default for the predefined account type Name (upper case); Fortnox then books with this account by default wherever it uses that type. The account must exist and be active; with EasyVat, SALES_*_SE types require an account with a compatible VAT code. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxUpdatePredefinedAccountInput.fields),
  outputSchema: FortnoxPredefinedAccount,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      'PUT',
      `predefinedaccounts/${encodeURIComponent(input.Name)}`,
      { PreDefinedAccount: { Account: input.Account } },
      PredefinedAccountResponse,
      value => value.PreDefinedAccount
    )
})

export const fortnoxListLabelsAction = defineAction({
  id: 'fortnox.list_labels',
  description:
    'List all Fortnox labels (Id, Description) that can be put on offers, orders, and invoices. Not paginated.',
  access: 'read',
  inputSchema: FortnoxListLabelsInput,
  outputSchema: FortnoxListLabelsOutput,
  execute: ({ integration }) =>
    readFortnox(integration, FortnoxSettingsOAuthCredentialSlot, 'labels', LabelsResponse, value =>
      FortnoxListLabelsOutput.make({ labels: Chunk.fromIterable(value.Labels) })
    )
})

export const fortnoxCreateLabelAction = defineAction({
  id: 'fortnox.create_label',
  description:
    'Create a Fortnox label with a Description of 1-25 characters. Fortnox assigns Id. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxCreateLabelInput.fields),
  outputSchema: FortnoxLabel,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      'POST',
      'labels',
      { Label: { Description: input.Description } },
      LabelResponse,
      value => value.Label
    )
})

export const fortnoxUpdateLabelAction = defineAction({
  id: 'fortnox.update_label',
  description:
    'Rename a Fortnox label by Id. Description (1-25 characters) is required. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateLabelInput.fields),
  outputSchema: FortnoxLabel,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      'PUT',
      `labels/${encodeURIComponent(String(input.Id))}`,
      { Label: { Description: input.Description } },
      LabelResponse,
      value => value.Label
    )
})

export const fortnoxDeleteLabelAction = defineAction({
  id: 'fortnox.delete_label',
  description:
    'Permanently delete a Fortnox label by labelId (the label Id). Fortnox also permanently removes it from every offer, order, and invoice that carries it. Cannot be undone.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxDeleteLabelInput.fields),
  outputSchema: FortnoxDeleteLabelOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxSettingsOAuthCredentialSlot,
      `labels/${encodeURIComponent(String(input.labelId))}`,
      FortnoxDeleteLabelOutput.make({ labelId: input.labelId, deleted: true })
    )
})

export const fortnoxSettingsActions = [
  fortnoxGetCompanySettingsAction,
  fortnoxGetLockedPeriodAction,
  fortnoxListPredefinedAccountsAction,
  fortnoxGetPredefinedAccountAction,
  fortnoxUpdatePredefinedAccountAction,
  fortnoxListLabelsAction,
  fortnoxCreateLabelAction,
  fortnoxUpdateLabelAction,
  fortnoxDeleteLabelAction
] as const
