// Fortnox code registers that need the `settings` scope (Fortnox docs, Scopes guide): modes of
// payment, terms of payment, terms of delivery, ways of delivery and units. Each register is keyed
// by a caller-chosen Code that is "only writable during POST" (Fortnox docs), so updates and
// deletes bind it into the URL and never send it in the body.
import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import {
  AccountNumber,
  Identifier,
  NonEmptyString,
  NullableInt,
  NullableString,
  OptionalString,
  PaginationFields,
  closedInput,
  optionalMaxLength
} from './fields.ts'
import { FortnoxSettingsOAuthCredentialSlot } from './oauth.ts'
import { FortnoxPagination } from './schemas.ts'
import {
  FortnoxMetaInformation,
  deleteFortnox,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'
import { WireNullableInt } from './wire.ts'

// Codes ------------------------------------------------------------------------------------------

export const FortnoxModeOfPaymentCode = Identifier.pipe(Schema.brand('FortnoxModeOfPaymentCode'))

export type FortnoxModeOfPaymentCode = typeof FortnoxModeOfPaymentCode.Type

export const FortnoxTermsOfPaymentCode = Identifier.pipe(Schema.brand('FortnoxTermsOfPaymentCode'))

export type FortnoxTermsOfPaymentCode = typeof FortnoxTermsOfPaymentCode.Type

export const FortnoxTermsOfDeliveryCode = Identifier.pipe(
  Schema.brand('FortnoxTermsOfDeliveryCode')
)

export type FortnoxTermsOfDeliveryCode = typeof FortnoxTermsOfDeliveryCode.Type

export const FortnoxWayOfDeliveryCode = Identifier.pipe(Schema.brand('FortnoxWayOfDeliveryCode'))

export type FortnoxWayOfDeliveryCode = typeof FortnoxWayOfDeliveryCode.Type

export const FortnoxUnitCode = Identifier.pipe(Schema.brand('FortnoxUnitCode'))

export type FortnoxUnitCode = typeof FortnoxUnitCode.Type

// Write-field limits follow the Fortnox OpenAPI payload schemas.
const RequiredText = (maxLength: number) => NonEmptyString.check(Schema.isMaxLength(maxLength))

// Fortnox sends AccountNumber as a string in list rows and as a number in single reads (Fortnox
// docs examples; OpenAPI types it as a string). Writes send a JSON number, as in the examples.
// Registers have no documented search fields that map to a query parameter name, and no
// LastModified field, so lists take only the global page/limit parameters.
const RegisterListFields = { page: PaginationFields.page, limit: PaginationFields.limit }

// Modes of payment ------------------------------------------------------------------------------

export class FortnoxModeOfPayment extends Schema.Class<FortnoxModeOfPayment>(
  'FortnoxModeOfPayment'
)({
  Code: FortnoxModeOfPaymentCode,
  Description: NullableString,
  AccountNumber: NullableInt
}) {}

export class FortnoxListModesOfPaymentInput extends Schema.Class<FortnoxListModesOfPaymentInput>(
  'FortnoxListModesOfPaymentInput'
)(RegisterListFields) {}

export class FortnoxListModesOfPaymentOutput extends Schema.Class<FortnoxListModesOfPaymentOutput>(
  'FortnoxListModesOfPaymentOutput'
)({ modesOfPayment: Schema.Chunk(FortnoxModeOfPayment), pagination: FortnoxPagination }) {}

export class FortnoxGetModeOfPaymentInput extends Schema.Class<FortnoxGetModeOfPaymentInput>(
  'FortnoxGetModeOfPaymentInput'
)({ code: FortnoxModeOfPaymentCode }) {}

export class FortnoxCreateModeOfPaymentInput extends Schema.Class<FortnoxCreateModeOfPaymentInput>(
  'FortnoxCreateModeOfPaymentInput'
)({
  Code: FortnoxModeOfPaymentCode,
  Description: OptionalString,
  AccountNumber
}) {}

export class FortnoxUpdateModeOfPaymentInput extends Schema.Class<FortnoxUpdateModeOfPaymentInput>(
  'FortnoxUpdateModeOfPaymentInput'
)({
  Code: FortnoxModeOfPaymentCode,
  Description: OptionalString,
  AccountNumber: Schema.optional(AccountNumber)
}) {}

export class FortnoxDeleteModeOfPaymentInput extends Schema.Class<FortnoxDeleteModeOfPaymentInput>(
  'FortnoxDeleteModeOfPaymentInput'
)({ code: FortnoxModeOfPaymentCode }) {}

export class FortnoxDeleteModeOfPaymentOutput extends Schema.Class<FortnoxDeleteModeOfPaymentOutput>(
  'FortnoxDeleteModeOfPaymentOutput'
)({ code: FortnoxModeOfPaymentCode, deleted: Schema.Literal(true) }) {}

const ModeOfPaymentApi = Schema.Struct({
  ...FortnoxModeOfPayment.fields,
  AccountNumber: WireNullableInt
})

const modeOfPaymentFromApi = (value: typeof ModeOfPaymentApi.Type) =>
  FortnoxModeOfPayment.make(value)

// Terms of payment ------------------------------------------------------------------------------

export class FortnoxTermsOfPayment extends Schema.Class<FortnoxTermsOfPayment>(
  'FortnoxTermsOfPayment'
)({
  Code: FortnoxTermsOfPaymentCode,
  Description: NullableString
}) {}

export class FortnoxListTermsOfPaymentInput extends Schema.Class<FortnoxListTermsOfPaymentInput>(
  'FortnoxListTermsOfPaymentInput'
)(RegisterListFields) {}

export class FortnoxListTermsOfPaymentOutput extends Schema.Class<FortnoxListTermsOfPaymentOutput>(
  'FortnoxListTermsOfPaymentOutput'
)({ termsOfPayment: Schema.Chunk(FortnoxTermsOfPayment), pagination: FortnoxPagination }) {}

export class FortnoxGetTermsOfPaymentInput extends Schema.Class<FortnoxGetTermsOfPaymentInput>(
  'FortnoxGetTermsOfPaymentInput'
)({ code: FortnoxTermsOfPaymentCode }) {}

export class FortnoxCreateTermsOfPaymentInput extends Schema.Class<FortnoxCreateTermsOfPaymentInput>(
  'FortnoxCreateTermsOfPaymentInput'
)({
  Code: FortnoxTermsOfPaymentCode.check(Schema.isMaxLength(25)),
  Description: NonEmptyString
}) {}

export class FortnoxUpdateTermsOfPaymentInput extends Schema.Class<FortnoxUpdateTermsOfPaymentInput>(
  'FortnoxUpdateTermsOfPaymentInput'
)({
  Code: FortnoxTermsOfPaymentCode,
  Description: Schema.optional(NonEmptyString)
}) {}

export class FortnoxDeleteTermsOfPaymentInput extends Schema.Class<FortnoxDeleteTermsOfPaymentInput>(
  'FortnoxDeleteTermsOfPaymentInput'
)({ code: FortnoxTermsOfPaymentCode }) {}

export class FortnoxDeleteTermsOfPaymentOutput extends Schema.Class<FortnoxDeleteTermsOfPaymentOutput>(
  'FortnoxDeleteTermsOfPaymentOutput'
)({ code: FortnoxTermsOfPaymentCode, deleted: Schema.Literal(true) }) {}

// Terms of delivery -----------------------------------------------------------------------------

export class FortnoxTermsOfDelivery extends Schema.Class<FortnoxTermsOfDelivery>(
  'FortnoxTermsOfDelivery'
)({
  Code: FortnoxTermsOfDeliveryCode,
  Description: NullableString,
  DescriptionEnglish: NullableString
}) {}

export class FortnoxListTermsOfDeliveryInput extends Schema.Class<FortnoxListTermsOfDeliveryInput>(
  'FortnoxListTermsOfDeliveryInput'
)(RegisterListFields) {}

export class FortnoxListTermsOfDeliveryOutput extends Schema.Class<FortnoxListTermsOfDeliveryOutput>(
  'FortnoxListTermsOfDeliveryOutput'
)({ termsOfDelivery: Schema.Chunk(FortnoxTermsOfDelivery), pagination: FortnoxPagination }) {}

export class FortnoxGetTermsOfDeliveryInput extends Schema.Class<FortnoxGetTermsOfDeliveryInput>(
  'FortnoxGetTermsOfDeliveryInput'
)({ code: FortnoxTermsOfDeliveryCode }) {}

export class FortnoxCreateTermsOfDeliveryInput extends Schema.Class<FortnoxCreateTermsOfDeliveryInput>(
  'FortnoxCreateTermsOfDeliveryInput'
)({
  Code: FortnoxTermsOfDeliveryCode.check(Schema.isMaxLength(20)),
  Description: RequiredText(200),
  DescriptionEnglish: optionalMaxLength(100)
}) {}

export class FortnoxUpdateTermsOfDeliveryInput extends Schema.Class<FortnoxUpdateTermsOfDeliveryInput>(
  'FortnoxUpdateTermsOfDeliveryInput'
)({
  Code: FortnoxTermsOfDeliveryCode,
  Description: Schema.optional(RequiredText(200)),
  DescriptionEnglish: optionalMaxLength(100)
}) {}

// Ways of delivery ------------------------------------------------------------------------------

export class FortnoxWayOfDelivery extends Schema.Class<FortnoxWayOfDelivery>(
  'FortnoxWayOfDelivery'
)({
  Code: FortnoxWayOfDeliveryCode,
  Description: NullableString,
  DescriptionEnglish: NullableString
}) {}

export class FortnoxListWaysOfDeliveryInput extends Schema.Class<FortnoxListWaysOfDeliveryInput>(
  'FortnoxListWaysOfDeliveryInput'
)(RegisterListFields) {}

export class FortnoxListWaysOfDeliveryOutput extends Schema.Class<FortnoxListWaysOfDeliveryOutput>(
  'FortnoxListWaysOfDeliveryOutput'
)({ waysOfDelivery: Schema.Chunk(FortnoxWayOfDelivery), pagination: FortnoxPagination }) {}

export class FortnoxGetWayOfDeliveryInput extends Schema.Class<FortnoxGetWayOfDeliveryInput>(
  'FortnoxGetWayOfDeliveryInput'
)({ code: FortnoxWayOfDeliveryCode }) {}

export class FortnoxCreateWayOfDeliveryInput extends Schema.Class<FortnoxCreateWayOfDeliveryInput>(
  'FortnoxCreateWayOfDeliveryInput'
)({
  Code: FortnoxWayOfDeliveryCode.check(Schema.isMaxLength(50)),
  Description: optionalMaxLength(100),
  DescriptionEnglish: optionalMaxLength(100)
}) {}

export class FortnoxUpdateWayOfDeliveryInput extends Schema.Class<FortnoxUpdateWayOfDeliveryInput>(
  'FortnoxUpdateWayOfDeliveryInput'
)({
  Code: FortnoxWayOfDeliveryCode,
  Description: optionalMaxLength(100),
  DescriptionEnglish: optionalMaxLength(100)
}) {}

export class FortnoxDeleteWayOfDeliveryInput extends Schema.Class<FortnoxDeleteWayOfDeliveryInput>(
  'FortnoxDeleteWayOfDeliveryInput'
)({ code: FortnoxWayOfDeliveryCode }) {}

export class FortnoxDeleteWayOfDeliveryOutput extends Schema.Class<FortnoxDeleteWayOfDeliveryOutput>(
  'FortnoxDeleteWayOfDeliveryOutput'
)({ code: FortnoxWayOfDeliveryCode, deleted: Schema.Literal(true) }) {}

// Units -----------------------------------------------------------------------------------------

export class FortnoxUnit extends Schema.Class<FortnoxUnit>('FortnoxUnit')({
  Code: FortnoxUnitCode,
  Description: NullableString,
  CodeEnglish: NullableString
}) {}

export class FortnoxListUnitsInput extends Schema.Class<FortnoxListUnitsInput>(
  'FortnoxListUnitsInput'
)(RegisterListFields) {}

export class FortnoxListUnitsOutput extends Schema.Class<FortnoxListUnitsOutput>(
  'FortnoxListUnitsOutput'
)({ units: Schema.Chunk(FortnoxUnit), pagination: FortnoxPagination }) {}

export class FortnoxGetUnitInput extends Schema.Class<FortnoxGetUnitInput>('FortnoxGetUnitInput')({
  code: FortnoxUnitCode
}) {}

export class FortnoxCreateUnitInput extends Schema.Class<FortnoxCreateUnitInput>(
  'FortnoxCreateUnitInput'
)({
  Code: FortnoxUnitCode.check(Schema.isMaxLength(20)),
  Description: RequiredText(100),
  CodeEnglish: optionalMaxLength(100)
}) {}

export class FortnoxUpdateUnitInput extends Schema.Class<FortnoxUpdateUnitInput>(
  'FortnoxUpdateUnitInput'
)({
  Code: FortnoxUnitCode,
  Description: Schema.optional(RequiredText(100)),
  CodeEnglish: optionalMaxLength(100)
}) {}

export class FortnoxDeleteUnitInput extends Schema.Class<FortnoxDeleteUnitInput>(
  'FortnoxDeleteUnitInput'
)({ code: FortnoxUnitCode }) {}

export class FortnoxDeleteUnitOutput extends Schema.Class<FortnoxDeleteUnitOutput>(
  'FortnoxDeleteUnitOutput'
)({ code: FortnoxUnitCode, deleted: Schema.Literal(true) }) {}

// Action factory --------------------------------------------------------------------------------

type Decodable<A> = Schema.Schema<A> & { readonly DecodingServices: never }

type Encodable<A> = Schema.Schema<A> & { readonly EncodingServices: never }

type RegisterActionText = {
  readonly list: string
  readonly get: string
  readonly create: string
  readonly update: string
}

/**
 * Builds list/get/create/update actions for one Code-keyed settings register, all on the
 * `settings` slot. Only the wiring is shared: every register passes its own exported schemas,
 * Fortnox envelope (`envelope` key for write bodies, decoders for responses) and model-facing
 * descriptions, so per-resource paths, envelopes and field rules stay explicit. Lists require
 * `MetaInformation` through the caller's response schema. Delete is a separate helper because
 * Fortnox does not document it for every register.
 */
const registerActions = <
  Item,
  ListInput extends { readonly page?: number; readonly limit?: number },
  ListWire,
  ListOutput,
  GetInput extends { readonly code: string },
  SingleWire,
  CreateInput extends { readonly Code: string },
  UpdateInput extends { readonly Code: string }
>(spec: {
  readonly path: string
  readonly envelope: string
  readonly ids: RegisterActionText
  readonly descriptions: RegisterActionText
  readonly item: Encodable<Item>
  readonly listInput: Decodable<ListInput>
  readonly listOutput: Encodable<ListOutput>
  readonly listResponse: Decodable<ListWire>
  readonly fromList: (value: ListWire) => ListOutput
  readonly getInput: Decodable<GetInput>
  readonly singleResponse: Decodable<SingleWire>
  readonly fromSingle: (value: SingleWire) => Item
  readonly createInput: Decodable<CreateInput>
  readonly updateInput: Decodable<UpdateInput>
}) => {
  const slot = FortnoxSettingsOAuthCredentialSlot
  const entryPath = (code: string) => `${spec.path}/${encodeURIComponent(code)}`

  return {
    list: defineAction({
      id: spec.ids.list,
      description: spec.descriptions.list,
      access: 'read',
      inputSchema: spec.listInput,
      outputSchema: spec.listOutput,
      execute: ({ integration, input }) =>
        readFortnox(integration, slot, listPath(spec.path, input), spec.listResponse, spec.fromList)
    }),
    get: defineAction({
      id: spec.ids.get,
      description: spec.descriptions.get,
      access: 'read',
      inputSchema: spec.getInput,
      outputSchema: spec.item,
      execute: ({ integration, input }) =>
        readFortnox(integration, slot, entryPath(input.code), spec.singleResponse, spec.fromSingle)
    }),
    create: defineAction({
      id: spec.ids.create,
      description: spec.descriptions.create,
      access: 'write',
      inputSchema: spec.createInput,
      outputSchema: spec.item,
      execute: ({ integration, input }) =>
        writeFortnox(
          integration,
          slot,
          'POST',
          spec.path,
          { [spec.envelope]: input },
          spec.singleResponse,
          spec.fromSingle
        )
    }),
    update: defineAction({
      id: spec.ids.update,
      description: spec.descriptions.update,
      access: 'write',
      inputSchema: spec.updateInput,
      outputSchema: spec.item,
      execute: ({ integration, input }) => {
        const { Code, ...entry } = input

        return writeFortnox(
          integration,
          slot,
          'PUT',
          entryPath(Code),
          { [spec.envelope]: entry },
          spec.singleResponse,
          spec.fromSingle
        )
      }
    })
  }
}

/** DELETE `{path}/{Code}`; Fortnox answers 204 without a body. */
const deleteRegisterAction = <Input extends { readonly code: string }, Output>(spec: {
  readonly id: string
  readonly description: string
  readonly path: string
  readonly input: Decodable<Input>
  readonly output: Encodable<Output>
  readonly deleted: (input: Input) => Output
}) =>
  defineAction({
    id: spec.id,
    description: spec.description,
    access: 'destructive',
    inputSchema: spec.input,
    outputSchema: spec.output,
    execute: ({ integration, input }) =>
      deleteFortnox(
        integration,
        FortnoxSettingsOAuthCredentialSlot,
        `${spec.path}/${encodeURIComponent(input.code)}`,
        spec.deleted(input)
      )
  })

const codeImmutableNote = 'Code is chosen on create and cannot be changed later.'

const updateNote =
  'Code identifies the entry and cannot be changed. Omitted fields are not sent. Unknown fields are rejected.'

const listNote = 'Repeat limit with pagination.nextPage to continue.'

const deleteNote = (label: string) =>
  `This permanently removes the ${label} from the Fortnox register and cannot be undone.`

// Modes of payment actions ----------------------------------------------------------------------

const modeOfPaymentActions = registerActions({
  path: 'modesofpayments',
  envelope: 'ModeOfPayment',
  ids: {
    list: 'fortnox.list_modes_of_payment',
    get: 'fortnox.get_mode_of_payment',
    create: 'fortnox.create_mode_of_payment',
    update: 'fortnox.update_mode_of_payment'
  },
  descriptions: {
    list: `List one page of Fortnox modes of payment (Code, Description, AccountNumber). ${listNote}`,
    get: 'Read a Fortnox mode of payment by Code.',
    create: `Create a Fortnox mode of payment. AccountNumber (4-digit bookkeeping account) is required. ${codeImmutableNote} Unknown fields are rejected.`,
    update: `Update a Fortnox mode of payment by Code. ${updateNote}`
  },
  item: FortnoxModeOfPayment,
  listInput: FortnoxListModesOfPaymentInput,
  listOutput: FortnoxListModesOfPaymentOutput,
  listResponse: Schema.Struct({
    ModesOfPayments: Schema.Array(ModeOfPaymentApi),
    MetaInformation: FortnoxMetaInformation
  }),
  fromList: value =>
    FortnoxListModesOfPaymentOutput.make({
      modesOfPayment: Chunk.fromIterable(value.ModesOfPayments.map(modeOfPaymentFromApi)),
      pagination: paginationFromApi(value.MetaInformation)
    }),
  getInput: FortnoxGetModeOfPaymentInput,
  singleResponse: Schema.Struct({ ModeOfPayment: ModeOfPaymentApi }),
  fromSingle: value => modeOfPaymentFromApi(value.ModeOfPayment),
  createInput: closedInput(FortnoxCreateModeOfPaymentInput.fields),
  updateInput: closedInput(FortnoxUpdateModeOfPaymentInput.fields)
})

export const fortnoxListModesOfPaymentAction = modeOfPaymentActions.list

export const fortnoxGetModeOfPaymentAction = modeOfPaymentActions.get

export const fortnoxCreateModeOfPaymentAction = modeOfPaymentActions.create

export const fortnoxUpdateModeOfPaymentAction = modeOfPaymentActions.update

export const fortnoxDeleteModeOfPaymentAction = deleteRegisterAction({
  id: 'fortnox.delete_mode_of_payment',
  description: `Delete a Fortnox mode of payment by Code. ${deleteNote('mode of payment')}`,
  path: 'modesofpayments',
  input: closedInput(FortnoxDeleteModeOfPaymentInput.fields),
  output: FortnoxDeleteModeOfPaymentOutput,
  deleted: ({ code }) => FortnoxDeleteModeOfPaymentOutput.make({ code, deleted: true })
})

// Terms of payment actions ----------------------------------------------------------------------

const termsOfPaymentActions = registerActions({
  path: 'termsofpayments',
  envelope: 'TermsOfPayment',
  ids: {
    list: 'fortnox.list_terms_of_payment',
    get: 'fortnox.get_terms_of_payment',
    create: 'fortnox.create_terms_of_payment',
    update: 'fortnox.update_terms_of_payment'
  },
  descriptions: {
    list: `List one page of Fortnox terms of payment (Code and Description; customers and invoices reference the Code as TermsOfPayment). ${listNote}`,
    get: 'Read Fortnox terms of payment by Code.',
    create: `Create Fortnox terms of payment with a Code (max 25 characters) and Description. ${codeImmutableNote} Unknown fields are rejected.`,
    update: `Update Fortnox terms of payment by Code. ${updateNote}`
  },
  item: FortnoxTermsOfPayment,
  listInput: FortnoxListTermsOfPaymentInput,
  listOutput: FortnoxListTermsOfPaymentOutput,
  listResponse: Schema.Struct({
    TermsOfPayments: Schema.Array(FortnoxTermsOfPayment),
    MetaInformation: FortnoxMetaInformation
  }),
  fromList: value =>
    FortnoxListTermsOfPaymentOutput.make({
      termsOfPayment: Chunk.fromIterable(value.TermsOfPayments),
      pagination: paginationFromApi(value.MetaInformation)
    }),
  getInput: FortnoxGetTermsOfPaymentInput,
  singleResponse: Schema.Struct({ TermsOfPayment: FortnoxTermsOfPayment }),
  fromSingle: value => value.TermsOfPayment,
  createInput: closedInput(FortnoxCreateTermsOfPaymentInput.fields),
  updateInput: closedInput(FortnoxUpdateTermsOfPaymentInput.fields)
})

export const fortnoxListTermsOfPaymentAction = termsOfPaymentActions.list

export const fortnoxGetTermsOfPaymentAction = termsOfPaymentActions.get

export const fortnoxCreateTermsOfPaymentAction = termsOfPaymentActions.create

export const fortnoxUpdateTermsOfPaymentAction = termsOfPaymentActions.update

export const fortnoxDeleteTermsOfPaymentAction = deleteRegisterAction({
  id: 'fortnox.delete_terms_of_payment',
  description: `Delete Fortnox terms of payment by Code. ${deleteNote('terms of payment')}`,
  path: 'termsofpayments',
  input: closedInput(FortnoxDeleteTermsOfPaymentInput.fields),
  output: FortnoxDeleteTermsOfPaymentOutput,
  deleted: ({ code }) => FortnoxDeleteTermsOfPaymentOutput.make({ code, deleted: true })
})

// Terms of delivery actions (Fortnox documents no DELETE) ---------------------------------------

const termsOfDeliveryActions = registerActions({
  path: 'termsofdeliveries',
  envelope: 'TermsOfDelivery',
  ids: {
    list: 'fortnox.list_terms_of_delivery',
    get: 'fortnox.get_terms_of_delivery',
    create: 'fortnox.create_terms_of_delivery',
    update: 'fortnox.update_terms_of_delivery'
  },
  descriptions: {
    list: `List one page of Fortnox terms of delivery (Code, Description, DescriptionEnglish). ${listNote}`,
    get: 'Read Fortnox terms of delivery by Code.',
    create: `Create Fortnox terms of delivery with a Code (max 20 characters) and Description. The Fortnox API has no delete for terms of delivery; a created entry can only be updated. ${codeImmutableNote} Unknown fields are rejected.`,
    update: `Update Fortnox terms of delivery by Code. ${updateNote}`
  },
  item: FortnoxTermsOfDelivery,
  listInput: FortnoxListTermsOfDeliveryInput,
  listOutput: FortnoxListTermsOfDeliveryOutput,
  listResponse: Schema.Struct({
    TermsOfDeliveries: Schema.Array(FortnoxTermsOfDelivery),
    MetaInformation: FortnoxMetaInformation
  }),
  fromList: value =>
    FortnoxListTermsOfDeliveryOutput.make({
      termsOfDelivery: Chunk.fromIterable(value.TermsOfDeliveries),
      pagination: paginationFromApi(value.MetaInformation)
    }),
  getInput: FortnoxGetTermsOfDeliveryInput,
  singleResponse: Schema.Struct({ TermsOfDelivery: FortnoxTermsOfDelivery }),
  fromSingle: value => value.TermsOfDelivery,
  createInput: closedInput(FortnoxCreateTermsOfDeliveryInput.fields),
  updateInput: closedInput(FortnoxUpdateTermsOfDeliveryInput.fields)
})

export const fortnoxListTermsOfDeliveryAction = termsOfDeliveryActions.list

export const fortnoxGetTermsOfDeliveryAction = termsOfDeliveryActions.get

export const fortnoxCreateTermsOfDeliveryAction = termsOfDeliveryActions.create

export const fortnoxUpdateTermsOfDeliveryAction = termsOfDeliveryActions.update

// Ways of delivery actions ----------------------------------------------------------------------

const wayOfDeliveryActions = registerActions({
  path: 'wayofdeliveries',
  envelope: 'WayOfDelivery',
  ids: {
    list: 'fortnox.list_ways_of_delivery',
    get: 'fortnox.get_way_of_delivery',
    create: 'fortnox.create_way_of_delivery',
    update: 'fortnox.update_way_of_delivery'
  },
  descriptions: {
    list: `List one page of Fortnox ways of delivery (Code, Description, DescriptionEnglish). ${listNote}`,
    get: 'Read a Fortnox way of delivery by Code.',
    create: `Create a Fortnox way of delivery with a Code (max 50 characters). ${codeImmutableNote} Unknown fields are rejected.`,
    update: `Update a Fortnox way of delivery by Code. ${updateNote}`
  },
  item: FortnoxWayOfDelivery,
  listInput: FortnoxListWaysOfDeliveryInput,
  listOutput: FortnoxListWaysOfDeliveryOutput,
  listResponse: Schema.Struct({
    WayOfDeliveries: Schema.Array(FortnoxWayOfDelivery),
    MetaInformation: FortnoxMetaInformation
  }),
  fromList: value =>
    FortnoxListWaysOfDeliveryOutput.make({
      waysOfDelivery: Chunk.fromIterable(value.WayOfDeliveries),
      pagination: paginationFromApi(value.MetaInformation)
    }),
  getInput: FortnoxGetWayOfDeliveryInput,
  singleResponse: Schema.Struct({ WayOfDelivery: FortnoxWayOfDelivery }),
  fromSingle: value => value.WayOfDelivery,
  createInput: closedInput(FortnoxCreateWayOfDeliveryInput.fields),
  updateInput: closedInput(FortnoxUpdateWayOfDeliveryInput.fields)
})

export const fortnoxListWaysOfDeliveryAction = wayOfDeliveryActions.list

export const fortnoxGetWayOfDeliveryAction = wayOfDeliveryActions.get

export const fortnoxCreateWayOfDeliveryAction = wayOfDeliveryActions.create

export const fortnoxUpdateWayOfDeliveryAction = wayOfDeliveryActions.update

export const fortnoxDeleteWayOfDeliveryAction = deleteRegisterAction({
  id: 'fortnox.delete_way_of_delivery',
  description: `Delete a Fortnox way of delivery by Code. ${deleteNote('way of delivery')}`,
  path: 'wayofdeliveries',
  input: closedInput(FortnoxDeleteWayOfDeliveryInput.fields),
  output: FortnoxDeleteWayOfDeliveryOutput,
  deleted: ({ code }) => FortnoxDeleteWayOfDeliveryOutput.make({ code, deleted: true })
})

// Units actions ---------------------------------------------------------------------------------

const unitActions = registerActions({
  path: 'units',
  envelope: 'Unit',
  ids: {
    list: 'fortnox.list_units',
    get: 'fortnox.get_unit',
    create: 'fortnox.create_unit',
    update: 'fortnox.update_unit'
  },
  descriptions: {
    list: `List one page of Fortnox units (Code, Description, CodeEnglish); articles and invoice rows reference the Code as Unit. ${listNote}`,
    get: 'Read a Fortnox unit by Code.',
    create: `Create a Fortnox unit with a Code (max 20 characters) and Description (max 100). ${codeImmutableNote} Unknown fields are rejected.`,
    update: `Update a Fortnox unit by Code. ${updateNote}`
  },
  item: FortnoxUnit,
  listInput: FortnoxListUnitsInput,
  listOutput: FortnoxListUnitsOutput,
  listResponse: Schema.Struct({
    Units: Schema.Array(FortnoxUnit),
    MetaInformation: FortnoxMetaInformation
  }),
  fromList: value =>
    FortnoxListUnitsOutput.make({
      units: Chunk.fromIterable(value.Units),
      pagination: paginationFromApi(value.MetaInformation)
    }),
  getInput: FortnoxGetUnitInput,
  singleResponse: Schema.Struct({ Unit: FortnoxUnit }),
  fromSingle: value => value.Unit,
  createInput: closedInput(FortnoxCreateUnitInput.fields),
  updateInput: closedInput(FortnoxUpdateUnitInput.fields)
})

export const fortnoxListUnitsAction = unitActions.list

export const fortnoxGetUnitAction = unitActions.get

export const fortnoxCreateUnitAction = unitActions.create

export const fortnoxUpdateUnitAction = unitActions.update

export const fortnoxDeleteUnitAction = deleteRegisterAction({
  id: 'fortnox.delete_unit',
  description: `Delete a Fortnox unit by Code. ${deleteNote('unit')}`,
  path: 'units',
  input: closedInput(FortnoxDeleteUnitInput.fields),
  output: FortnoxDeleteUnitOutput,
  deleted: ({ code }) => FortnoxDeleteUnitOutput.make({ code, deleted: true })
})

export const fortnoxSettingsRegisterActions = [
  fortnoxListModesOfPaymentAction,
  fortnoxGetModeOfPaymentAction,
  fortnoxCreateModeOfPaymentAction,
  fortnoxUpdateModeOfPaymentAction,
  fortnoxDeleteModeOfPaymentAction,
  fortnoxListTermsOfPaymentAction,
  fortnoxGetTermsOfPaymentAction,
  fortnoxCreateTermsOfPaymentAction,
  fortnoxUpdateTermsOfPaymentAction,
  fortnoxDeleteTermsOfPaymentAction,
  fortnoxListTermsOfDeliveryAction,
  fortnoxGetTermsOfDeliveryAction,
  fortnoxCreateTermsOfDeliveryAction,
  fortnoxUpdateTermsOfDeliveryAction,
  fortnoxListWaysOfDeliveryAction,
  fortnoxGetWayOfDeliveryAction,
  fortnoxCreateWayOfDeliveryAction,
  fortnoxUpdateWayOfDeliveryAction,
  fortnoxDeleteWayOfDeliveryAction,
  fortnoxListUnitsAction,
  fortnoxGetUnitAction,
  fortnoxCreateUnitAction,
  fortnoxUpdateUnitAction,
  fortnoxDeleteUnitAction
] as const
