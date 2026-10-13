// Fortnox `price` scope: price lists (`/3/pricelists`) and article prices (`/3/prices`).
import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import {
  closedInput,
  Identifier,
  NonEmptyString,
  NullableBoolean,
  NullableNumber,
  NullableString,
  OptionalNumber,
  OptionalString,
  PaginationFields
} from './fields.ts'
import { FortnoxArticleNumber } from './articles.ts'
import { FortnoxPriceOAuthCredentialSlot } from './oauth.ts'
import { FortnoxPagination } from './schemas.ts'
import {
  deleteFortnox,
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'

export const FortnoxPriceListCode = Identifier.pipe(Schema.brand('FortnoxPriceListCode'))

export type FortnoxPriceListCode = typeof FortnoxPriceListCode.Type

// FromQuantity is part of a price's URL path. Only values whose JavaScript string form is a plain
// decimal (0, 10, 2.5; no exponent) encode to one canonical path segment.
export const FortnoxPriceFromQuantity = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.makeFilter((value: number) =>
    /e/i.test(String(value))
      ? 'Expected a FromQuantity with a plain decimal form (at least 0.000001 and below 1e21, or 0)'
      : true
  )
)

const fromQuantitySegment = (value: number) => encodeURIComponent(String(value))

const pricePath = (priceList: string, articleNumber: string, fromQuantity: number) =>
  `prices/${encodeURIComponent(priceList)}/${encodeURIComponent(articleNumber)}/${fromQuantitySegment(fromQuantity)}`

// Fortnox docs: PreSelected is read-only (the default price list); Code is writable only on create.
export class FortnoxPriceList extends Schema.Class<FortnoxPriceList>('FortnoxPriceList')({
  Code: FortnoxPriceListCode,
  Description: NullableString,
  Comments: NullableString,
  PreSelected: NullableBoolean
}) {}

// List rows (`/prices/sublist`) are a slimmer version of the same fields.
export class FortnoxPrice extends Schema.Class<FortnoxPrice>('FortnoxPrice')({
  PriceList: FortnoxPriceListCode,
  ArticleNumber: FortnoxArticleNumber,
  FromQuantity: FortnoxPriceFromQuantity,
  Price: NullableNumber,
  Percent: NullableNumber,
  Date: NullableString
}) {}

export class FortnoxPriceListSearch extends Schema.Class<FortnoxPriceListSearch>(
  'FortnoxPriceListSearch'
)({
  field: Schema.Literals(['code', 'comments']),
  value: NonEmptyString
}) {}

export class FortnoxListPriceListsInput extends Schema.Class<FortnoxListPriceListsInput>(
  'FortnoxListPriceListsInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxPriceListSearch)
}) {}

export class FortnoxListPriceListsOutput extends Schema.Class<FortnoxListPriceListsOutput>(
  'FortnoxListPriceListsOutput'
)({
  priceLists: Schema.Chunk(FortnoxPriceList),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetPriceListInput extends Schema.Class<FortnoxGetPriceListInput>(
  'FortnoxGetPriceListInput'
)({
  code: FortnoxPriceListCode
}) {}

const PriceListDescription = NonEmptyString.check(Schema.isMaxLength(50))

export class FortnoxCreatePriceListInput extends Schema.Class<FortnoxCreatePriceListInput>(
  'FortnoxCreatePriceListInput'
)({
  Code: FortnoxPriceListCode.check(Schema.isMaxLength(100)),
  Description: PriceListDescription,
  Comments: OptionalString
}) {}

export class FortnoxUpdatePriceListInput extends Schema.Class<FortnoxUpdatePriceListInput>(
  'FortnoxUpdatePriceListInput'
)({
  Code: FortnoxPriceListCode,
  Description: Schema.optional(PriceListDescription),
  Comments: OptionalString
}) {}

export class FortnoxListPricesInput extends Schema.Class<FortnoxListPricesInput>(
  'FortnoxListPricesInput'
)({
  ...PaginationFields,
  priceList: FortnoxPriceListCode,
  articleNumber: FortnoxArticleNumber
}) {}

export class FortnoxListPricesOutput extends Schema.Class<FortnoxListPricesOutput>(
  'FortnoxListPricesOutput'
)({
  prices: Schema.Chunk(FortnoxPrice),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetPriceInput extends Schema.Class<FortnoxGetPriceInput>(
  'FortnoxGetPriceInput'
)({
  priceList: FortnoxPriceListCode,
  articleNumber: FortnoxArticleNumber,
  fromQuantity: FortnoxPriceFromQuantity
}) {}

// Fortnox docs: Date is read-only (last modification).
export class FortnoxCreatePriceInput extends Schema.Class<FortnoxCreatePriceInput>(
  'FortnoxCreatePriceInput'
)({
  PriceList: FortnoxPriceListCode,
  ArticleNumber: FortnoxArticleNumber,
  FromQuantity: FortnoxPriceFromQuantity,
  Price: OptionalNumber,
  Percent: OptionalNumber
}) {}

export class FortnoxUpdatePriceInput extends Schema.Class<FortnoxUpdatePriceInput>(
  'FortnoxUpdatePriceInput'
)({
  PriceList: FortnoxPriceListCode,
  ArticleNumber: FortnoxArticleNumber,
  FromQuantity: FortnoxPriceFromQuantity,
  Price: OptionalNumber,
  Percent: OptionalNumber
}) {}

export class FortnoxDeletePriceInput extends Schema.Class<FortnoxDeletePriceInput>(
  'FortnoxDeletePriceInput'
)({
  priceList: FortnoxPriceListCode,
  articleNumber: FortnoxArticleNumber,
  fromQuantity: FortnoxPriceFromQuantity
}) {}

export class FortnoxDeletePriceOutput extends Schema.Class<FortnoxDeletePriceOutput>(
  'FortnoxDeletePriceOutput'
)({
  priceList: FortnoxPriceListCode,
  articleNumber: FortnoxArticleNumber,
  fromQuantity: FortnoxPriceFromQuantity,
  deleted: Schema.Literal(true)
}) {}

const PriceListsResponse = Schema.Struct({
  PriceLists: Schema.Array(FortnoxPriceList),
  MetaInformation: FortnoxMetaInformation
})

const PriceListResponse = Schema.Struct({ PriceList: FortnoxPriceList })

const PricesResponse = Schema.Struct({
  Prices: Schema.Array(FortnoxPrice),
  MetaInformation: FortnoxMetaInformation
})

const PriceResponse = Schema.Struct({ Price: FortnoxPrice })

const defaultPriceListNote =
  'The default price list is usually Code "A"; PreSelected marks the company default.'

const priceKeyNote =
  'A price is identified by PriceList + ArticleNumber + FromQuantity (the quantity from which it applies; 0 for the base price).'

export const fortnoxListPriceListsAction = defineAction({
  id: 'fortnox.list_price_lists',
  description: `List one page of Fortnox price lists. Repeat search/limit with pagination.nextPage to continue. ${defaultPriceListNote}`,
  access: 'read',
  inputSchema: FortnoxListPriceListsInput,
  outputSchema: FortnoxListPriceListsOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      listPath('pricelists', input),
      PriceListsResponse,
      value =>
        FortnoxListPriceListsOutput.make({
          priceLists: Chunk.fromIterable(value.PriceLists),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetPriceListAction = defineAction({
  id: 'fortnox.get_price_list',
  description: `Read a Fortnox price list by Code. ${defaultPriceListNote}`,
  access: 'read',
  inputSchema: FortnoxGetPriceListInput,
  outputSchema: FortnoxPriceList,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      `pricelists/${encodeURIComponent(input.code)}`,
      PriceListResponse,
      value => value.PriceList
    )
})

export const fortnoxCreatePriceListAction = defineAction({
  id: 'fortnox.create_price_list',
  description:
    'Create a Fortnox price list with a caller-chosen Code (cannot be changed later) and Description (max 50 characters). PreSelected is read-only. Unknown fields are rejected. Fortnox documents no way to delete a price list.',
  access: 'write',
  inputSchema: closedInput(FortnoxCreatePriceListInput.fields),
  outputSchema: FortnoxPriceList,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      'POST',
      'pricelists',
      { PriceList: input },
      PriceListResponse,
      value => value.PriceList
    )
})

export const fortnoxUpdatePriceListAction = defineAction({
  id: 'fortnox.update_price_list',
  description:
    'Update a Fortnox price list Description or Comments by Code. Code itself cannot be changed and PreSelected is read-only. Only provided fields change. Unknown fields are rejected.',
  access: 'write',
  inputSchema: closedInput(FortnoxUpdatePriceListInput.fields),
  outputSchema: FortnoxPriceList,
  execute: ({ integration, input }) => {
    const { Code, ...priceList } = input

    return writeFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      'PUT',
      `pricelists/${encodeURIComponent(Code)}`,
      { PriceList: priceList },
      PriceListResponse,
      value => value.PriceList
    )
  }
})

export const fortnoxListPricesAction = defineAction({
  id: 'fortnox.list_prices',
  description: `List one page of an article's prices (all FromQuantity tiers) in one Fortnox price list. Rows may omit Percent and Date; use fortnox.get_price for the full price. Repeat with pagination.nextPage to continue. ${priceKeyNote} ${defaultPriceListNote}`,
  access: 'read',
  inputSchema: FortnoxListPricesInput,
  outputSchema: FortnoxListPricesOutput,
  execute: ({ integration, input }) => {
    const { priceList, articleNumber, ...pagination } = input

    return readFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      listPath(
        `prices/sublist/${encodeURIComponent(priceList)}/${encodeURIComponent(articleNumber)}`,
        pagination
      ),
      PricesResponse,
      value =>
        FortnoxListPricesOutput.make({
          prices: Chunk.fromIterable(value.Prices),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
  }
})

export const fortnoxGetPriceAction = defineAction({
  id: 'fortnox.get_price',
  description: `Read one Fortnox article price. ${priceKeyNote} ${defaultPriceListNote}`,
  access: 'read',
  inputSchema: FortnoxGetPriceInput,
  outputSchema: FortnoxPrice,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      pricePath(input.priceList, input.articleNumber, input.fromQuantity),
      PriceResponse,
      value => value.Price
    )
})

export const fortnoxCreatePriceAction = defineAction({
  id: 'fortnox.create_price',
  description: `Create a Fortnox article price in a price list. ${priceKeyNote} The article and price list must already exist. Date is read-only. Unknown fields are rejected.`,
  access: 'write',
  inputSchema: closedInput(FortnoxCreatePriceInput.fields),
  outputSchema: FortnoxPrice,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      'POST',
      'prices',
      { Price: input },
      PriceResponse,
      value => value.Price
    )
})

export const fortnoxUpdatePriceAction = defineAction({
  id: 'fortnox.update_price',
  description: `Update the Price or Percent of one Fortnox article price. ${priceKeyNote} The key fields only address the price and are not changed. Only provided fields change. Unknown fields are rejected.`,
  access: 'write',
  inputSchema: closedInput(FortnoxUpdatePriceInput.fields),
  outputSchema: FortnoxPrice,
  execute: ({ integration, input }) => {
    const { PriceList, ArticleNumber: articleNumber, FromQuantity, ...price } = input

    return writeFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      'PUT',
      pricePath(PriceList, articleNumber, FromQuantity),
      { Price: price },
      PriceResponse,
      value => value.Price
    )
  }
})

export const fortnoxDeletePriceAction = defineAction({
  id: 'fortnox.delete_price',
  description: `Permanently delete one Fortnox article price. ${priceKeyNote} This cannot be undone; the price must be recreated with fortnox.create_price. The article and price list are kept.`,
  access: 'destructive',
  inputSchema: closedInput(FortnoxDeletePriceInput.fields),
  outputSchema: FortnoxDeletePriceOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxPriceOAuthCredentialSlot,
      pricePath(input.priceList, input.articleNumber, input.fromQuantity),
      FortnoxDeletePriceOutput.make({
        priceList: input.priceList,
        articleNumber: input.articleNumber,
        fromQuantity: input.fromQuantity,
        deleted: true
      })
    )
})

export const fortnoxPriceActions = [
  fortnoxListPriceListsAction,
  fortnoxGetPriceListAction,
  fortnoxCreatePriceListAction,
  fortnoxUpdatePriceListAction,
  fortnoxListPricesAction,
  fortnoxGetPriceAction,
  fortnoxCreatePriceAction,
  fortnoxUpdatePriceAction,
  fortnoxDeletePriceAction
] as const
