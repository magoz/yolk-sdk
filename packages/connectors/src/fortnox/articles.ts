import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import {
  closedInput,
  Identifier,
  NonEmptyString,
  NullableBoolean,
  NullableInt,
  NullableNumber,
  NullableString,
  OptionalBoolean,
  OptionalInt,
  OptionalNumber,
  OptionalString,
  PaginationFields,
  optionalMaxLength
} from './fields.ts'
import { FortnoxArticleOAuthCredentialSlot } from './oauth.ts'
import { FortnoxPagination } from './schemas.ts'
import {
  deleteFortnox,
  FortnoxMetaInformation,
  listPath,
  paginationFromApi,
  readFortnox,
  writeFortnox
} from './shared.ts'
import { WireNullableNumber } from './wire.ts'

export const FortnoxArticleNumber = Identifier.pipe(Schema.brand('FortnoxArticleNumber'))

export type FortnoxArticleNumber = typeof FortnoxArticleNumber.Type

// Bounded read model of the Fortnox Article resource. SalesPrice (price in the default price
// list), DisposableQuantity, ReservedQuantity, StockValue, and SupplierName are read-only.
export class FortnoxArticle extends Schema.Class<FortnoxArticle>('FortnoxArticle')({
  ArticleNumber: FortnoxArticleNumber,
  Description: Schema.String,
  Active: NullableBoolean,
  Type: NullableString,
  Unit: NullableString,
  EAN: NullableString,
  VAT: NullableNumber,
  SalesPrice: NullableNumber,
  PurchasePrice: NullableNumber,
  QuantityInStock: NullableNumber,
  ReservedQuantity: NullableNumber,
  DisposableQuantity: NullableNumber,
  StockValue: NullableNumber,
  StockGoods: NullableBoolean,
  StockPlace: NullableString,
  StockWarning: NullableNumber,
  SalesAccount: NullableInt,
  PurchaseAccount: NullableInt,
  EUAccount: NullableInt,
  EUVATAccount: NullableInt,
  ExportAccount: NullableInt,
  ConstructionAccount: NullableInt,
  Manufacturer: NullableString,
  ManufacturerArticleNumber: NullableString,
  SupplierNumber: NullableString,
  SupplierName: NullableString,
  Note: NullableString,
  WebshopArticle: NullableBoolean,
  Housework: NullableBoolean,
  HouseworkType: NullableString,
  Expired: NullableBoolean,
  Bulky: NullableBoolean,
  Weight: NullableInt,
  Width: NullableInt,
  Height: NullableInt,
  Depth: NullableInt
}) {}

// Fortnox docs: list rows send quantities, prices, and VAT as numeric strings (e.g.
// "QuantityInStock": "0") while single-article reads send JSON numbers.
const FortnoxArticleApi = Schema.Struct({
  ...FortnoxArticle.fields,
  VAT: WireNullableNumber,
  SalesPrice: WireNullableNumber,
  PurchasePrice: WireNullableNumber,
  QuantityInStock: WireNullableNumber,
  ReservedQuantity: WireNullableNumber,
  DisposableQuantity: WireNullableNumber,
  StockValue: WireNullableNumber,
  StockWarning: WireNullableNumber
})

const articleFromApi = (value: typeof FortnoxArticleApi.Type) => FortnoxArticle.make(value)

// Fortnox docs list these query keys as the article search fields.
export class FortnoxArticleSearch extends Schema.Class<FortnoxArticleSearch>(
  'FortnoxArticleSearch'
)({
  field: Schema.Literals([
    'articlenumber',
    'description',
    'ean',
    'suppliernumber',
    'manufacturer',
    'manufacturerarticlenumber'
  ]),
  value: NonEmptyString
}) {}

export class FortnoxListArticlesInput extends Schema.Class<FortnoxListArticlesInput>(
  'FortnoxListArticlesInput'
)({
  ...PaginationFields,
  search: Schema.optional(FortnoxArticleSearch),
  filter: Schema.optional(Schema.Literals(['active', 'inactive']))
}) {}

export class FortnoxListArticlesOutput extends Schema.Class<FortnoxListArticlesOutput>(
  'FortnoxListArticlesOutput'
)({
  articles: Schema.Chunk(FortnoxArticle),
  pagination: FortnoxPagination
}) {}

export class FortnoxGetArticleInput extends Schema.Class<FortnoxGetArticleInput>(
  'FortnoxGetArticleInput'
)({
  articleNumber: FortnoxArticleNumber
}) {}

export class FortnoxDeleteArticleInput extends Schema.Class<FortnoxDeleteArticleInput>(
  'FortnoxDeleteArticleInput'
)({
  articleNumber: FortnoxArticleNumber
}) {}

export class FortnoxDeleteArticleOutput extends Schema.Class<FortnoxDeleteArticleOutput>(
  'FortnoxDeleteArticleOutput'
)({
  articleNumber: FortnoxArticleNumber,
  deleted: Schema.Literal(true)
}) {}

// Fortnox docs: dimensions and weight are integers of at most 8 digits (mm / g).
const Dimension = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99_999_999 }))
)

const ArticleDescription = NonEmptyString.check(Schema.isMaxLength(200))

// Writable Article fields per Fortnox docs. Read-only SalesPrice, DisposableQuantity,
// ReservedQuantity, StockValue, and SupplierName are not inputs.
const ArticleMutationFields = {
  Active: OptionalBoolean,
  Type: Schema.optional(Schema.Literals(['STOCK', 'SERVICE'])),
  Unit: OptionalString,
  EAN: optionalMaxLength(30),
  VAT: OptionalNumber,
  PurchasePrice: OptionalNumber,
  StockGoods: OptionalBoolean,
  StockPlace: optionalMaxLength(100),
  StockWarning: OptionalNumber,
  SalesAccount: OptionalInt,
  PurchaseAccount: OptionalInt,
  EUAccount: OptionalInt,
  EUVATAccount: OptionalInt,
  ExportAccount: OptionalInt,
  ConstructionAccount: OptionalInt,
  Manufacturer: optionalMaxLength(50),
  ManufacturerArticleNumber: optionalMaxLength(50),
  SupplierNumber: OptionalString,
  Note: optionalMaxLength(10_000),
  WebshopArticle: OptionalBoolean,
  Housework: OptionalBoolean,
  HouseworkType: Schema.optional(
    Schema.Literals([
      'CONSTRUCTION',
      'ELECTRICITY',
      'GLASSMETALWORK',
      'GROUNDDRAINAGEWORK',
      'MASONRY',
      'PAINTINGWALLPAPERING',
      'HVAC',
      'CLEANING',
      'TEXTILECLOTHING',
      'COOKING',
      'SNOWPLOWING',
      'GARDENING',
      'BABYSITTING',
      'OTHERCARE',
      'TUTORING',
      'FURNISHING',
      'HOMEMAINTENANCE',
      'TRANSPORTATIONSERVICES',
      'WASHINGANDCAREOFCLOTHING',
      'SOLARCELLS',
      'STORAGESELFPRODUCEDELECTRICITY',
      'CHARGINGSTATIONELECTRICVEHICLE',
      'EMPTYHOUSEWORK',
      'OTHERCOSTS'
    ])
  ),
  Expired: OptionalBoolean,
  Bulky: OptionalBoolean,
  Weight: Dimension,
  Width: Dimension,
  Height: Dimension,
  Depth: Dimension
}

export class FortnoxCreateArticleInput extends Schema.Class<FortnoxCreateArticleInput>(
  'FortnoxCreateArticleInput'
)({
  ArticleNumber: Schema.optional(FortnoxArticleNumber.check(Schema.isMaxLength(50))),
  Description: ArticleDescription,
  ...ArticleMutationFields
}) {}

export class FortnoxUpdateArticleInput extends Schema.Class<FortnoxUpdateArticleInput>(
  'FortnoxUpdateArticleInput'
)({
  ArticleNumber: FortnoxArticleNumber,
  Description: Schema.optional(ArticleDescription),
  ...ArticleMutationFields
}) {}

const ArticlesResponse = Schema.Struct({
  Articles: Schema.Array(FortnoxArticleApi),
  MetaInformation: FortnoxMetaInformation
})

const ArticleResponse = Schema.Struct({ Article: FortnoxArticleApi })

const fortnoxArticleReferencesNote =
  'Referenced Unit, SupplierNumber, and account numbers must already exist in the Fortnox company. SalesPrice is read-only (the default price list price); it cannot be set here. Unknown fields are rejected.'

const articlePath = (articleNumber: string) => `articles/${encodeURIComponent(articleNumber)}`

export const fortnoxListArticlesAction = defineAction({
  id: 'fortnox.list_articles',
  description:
    'List one page of Fortnox articles (products and services), ordered by ArticleNumber. Repeat search/filter/limit with pagination.nextPage to continue.',
  access: 'read',
  inputSchema: FortnoxListArticlesInput,
  outputSchema: FortnoxListArticlesOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxArticleOAuthCredentialSlot,
      listPath('articles', input),
      ArticlesResponse,
      value =>
        FortnoxListArticlesOutput.make({
          articles: Chunk.fromIterable(value.Articles.map(articleFromApi)),
          pagination: paginationFromApi(value.MetaInformation)
        })
    )
})

export const fortnoxGetArticleAction = defineAction({
  id: 'fortnox.get_article',
  description:
    'Read a Fortnox article by ArticleNumber, including stock quantities and the read-only SalesPrice from the default price list.',
  access: 'read',
  inputSchema: FortnoxGetArticleInput,
  outputSchema: FortnoxArticle,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxArticleOAuthCredentialSlot,
      articlePath(input.articleNumber),
      ArticleResponse,
      value => articleFromApi(value.Article)
    )
})

export const fortnoxCreateArticleAction = defineAction({
  id: 'fortnox.create_article',
  description: `Create a Fortnox article. Description is required. ArticleNumber is optional; if omitted, Fortnox assigns the next number in the series. ${fortnoxArticleReferencesNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxCreateArticleInput.fields),
  outputSchema: FortnoxArticle,
  execute: ({ integration, input }) =>
    writeFortnox(
      integration,
      FortnoxArticleOAuthCredentialSlot,
      'POST',
      'articles',
      { Article: input },
      ArticleResponse,
      value => articleFromApi(value.Article)
    )
})

export const fortnoxUpdateArticleAction = defineAction({
  id: 'fortnox.update_article',
  description: `Update a Fortnox article by ArticleNumber. Only provided fields change; omitted fields keep their stored value. The ArticleNumber of an existing article cannot be changed. ${fortnoxArticleReferencesNote}`,
  access: 'write',
  inputSchema: closedInput(FortnoxUpdateArticleInput.fields),
  outputSchema: FortnoxArticle,
  execute: ({ integration, input }) => {
    const { ArticleNumber, ...article } = input

    return writeFortnox(
      integration,
      FortnoxArticleOAuthCredentialSlot,
      'PUT',
      articlePath(ArticleNumber),
      { Article: article },
      ArticleResponse,
      value => articleFromApi(value.Article)
    )
  }
})

export const fortnoxDeleteArticleAction = defineAction({
  id: 'fortnox.delete_article',
  description:
    'Permanently delete a Fortnox article by ArticleNumber. This cannot be undone. To keep the article for history, update it with Active false instead.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxDeleteArticleInput.fields),
  outputSchema: FortnoxDeleteArticleOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxArticleOAuthCredentialSlot,
      articlePath(input.articleNumber),
      FortnoxDeleteArticleOutput.make({ articleNumber: input.articleNumber, deleted: true })
    )
})

export const fortnoxArticleActions = [
  fortnoxListArticlesAction,
  fortnoxGetArticleAction,
  fortnoxCreateArticleAction,
  fortnoxUpdateArticleAction,
  fortnoxDeleteArticleAction
] as const
