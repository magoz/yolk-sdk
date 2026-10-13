import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import {
  closedInput,
  Identifier,
  NonEmptyString,
  NullableBoolean,
  NullableString,
  OptionalBoolean,
  OptionalString,
  PaginationFields
} from './fields.ts'
import { FortnoxCostCenterOAuthCredentialSlot } from './oauth.ts'
import { FortnoxPagination } from './schemas.ts'
import {
  deleteFortnox,
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'

export const FortnoxCostCenterCode = Identifier.pipe(Schema.brand('FortnoxCostCenterCode'))

export type FortnoxCostCenterCode = typeof FortnoxCostCenterCode.Type

// Fortnox Cost Center resource (Kostnadsställe). Code is writable only on create.
export class FortnoxCostCenter extends Schema.Class<FortnoxCostCenter>('FortnoxCostCenter')({
  Code: FortnoxCostCenterCode,
  Description: NullableString,
  Note: NullableString,
  Active: NullableBoolean
}) {}

export class FortnoxListCostCentersInput extends Schema.Class<FortnoxListCostCentersInput>(
  'FortnoxListCostCentersInput'
)({
  ...PaginationFields
}) {}

export class FortnoxListCostCentersOutput extends Schema.Class<FortnoxListCostCentersOutput>(
  'FortnoxListCostCentersOutput'
)({
  costCenters: Schema.Chunk(FortnoxCostCenter),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetCostCenterInput extends Schema.Class<FortnoxGetCostCenterInput>(
  'FortnoxGetCostCenterInput'
)({
  code: FortnoxCostCenterCode
}) {}

// Fortnox docs (OpenAPI): Code is 1-6 characters.
export class FortnoxCreateCostCenterInput extends Schema.Class<FortnoxCreateCostCenterInput>(
  'FortnoxCreateCostCenterInput'
)({
  Code: FortnoxCostCenterCode.check(Schema.isMaxLength(6)),
  Description: NonEmptyString,
  Note: OptionalString,
  Active: OptionalBoolean
}) {}

export class FortnoxUpdateCostCenterInput extends Schema.Class<FortnoxUpdateCostCenterInput>(
  'FortnoxUpdateCostCenterInput'
)({
  Code: FortnoxCostCenterCode,
  Description: Schema.optional(NonEmptyString),
  Note: OptionalString,
  Active: OptionalBoolean
}) {}

export class FortnoxDeleteCostCenterInput extends Schema.Class<FortnoxDeleteCostCenterInput>(
  'FortnoxDeleteCostCenterInput'
)({
  code: FortnoxCostCenterCode
}) {}

export class FortnoxDeleteCostCenterOutput extends Schema.Class<FortnoxDeleteCostCenterOutput>(
  'FortnoxDeleteCostCenterOutput'
)({
  code: FortnoxCostCenterCode,
  deleted: Schema.Literal(true)
}) {}

const CostCentersResponse = Schema.Struct({
  CostCenters: Schema.Array(FortnoxCostCenter),
  MetaInformation: FortnoxMetaInformation
})

const CostCenterResponse = Schema.Struct({ CostCenter: FortnoxCostCenter })

const costCenterPath = (code: string) => `costcenters/${encodeURIComponent(code)}`

export const fortnoxListCostCentersAction = defineAction({
  id: 'fortnox.list_cost_centers',
  description:
    'List one page of Fortnox cost centers (kostnadsställen), including inactive ones. Repeat lastModified/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListCostCentersInput,
  outputSchema: FortnoxListCostCentersOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxCostCenterOAuthCredentialSlot,
      listPath('costcenters', input),
      CostCentersResponse,
      value =>
        FortnoxListCostCentersOutput.make({
          costCenters: Chunk.fromIterable(value.CostCenters),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetCostCenterAction = defineAction({
  id: 'fortnox.get_cost_center',
  description: 'Read a Fortnox cost center by Code.',
  access: 'read',
  inputSchema: FortnoxGetCostCenterInput,
  outputSchema: FortnoxCostCenter,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxCostCenterOAuthCredentialSlot,
      costCenterPath(input.code),
      CostCenterResponse,
      value => value.CostCenter
    )
})

export const fortnoxCreateCostCenterAction = defineAction({
  id: 'fortnox.create_cost_center',
  description:
    'Create a Fortnox cost center. Code (1-6 characters, chosen by the caller and unchangeable afterwards) and Description are required. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxCreateCostCenterInput.fields),
  outputSchema: FortnoxCostCenter,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxCostCenterOAuthCredentialSlot,
      'POST',
      'costcenters',
      { CostCenter: input },
      CostCenterResponse,
      value => value.CostCenter
    )
})

export const fortnoxUpdateCostCenterAction = defineAction({
  id: 'fortnox.update_cost_center',
  description:
    'Update a Fortnox cost center by Code. Only provided fields change; omitted fields keep their stored value. Code cannot be changed. Set Active false to deactivate it reversibly. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateCostCenterInput.fields),
  outputSchema: FortnoxCostCenter,
  execute: ({ integration, input }) => {
    const { Code, ...costCenter } = input

    return writeFortnox(
      integration,
      FortnoxCostCenterOAuthCredentialSlot,
      'PUT',
      costCenterPath(Code),
      { CostCenter: costCenter },
      CostCenterResponse,
      value => value.CostCenter
    )
  }
})

export const fortnoxDeleteCostCenterAction = defineAction({
  id: 'fortnox.delete_cost_center',
  description:
    'Permanently delete a Fortnox cost center by Code. This cannot be undone. To stop using it while keeping history, update it with Active false instead.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxDeleteCostCenterInput.fields),
  outputSchema: FortnoxDeleteCostCenterOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxCostCenterOAuthCredentialSlot,
      costCenterPath(input.code),
      FortnoxDeleteCostCenterOutput.make({ code: input.code, deleted: true })
    )
})

export const fortnoxCostCenterActions = [
  fortnoxListCostCentersAction,
  fortnoxGetCostCenterAction,
  fortnoxCreateCostCenterAction,
  fortnoxUpdateCostCenterAction,
  fortnoxDeleteCostCenterAction
] as const
