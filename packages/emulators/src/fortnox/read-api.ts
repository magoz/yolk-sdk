/**
 * Fortnox emulator read-only routes (internal; part of the route table in `src/fortnox/api.ts`):
 * every `GET` the connector's article, price, cost center, payment, offer, print template, inbox,
 * settings, settings register, and profile actions (and the host-only offer preview and inbox file
 * downloads) send. No route here writes, and their writes (POST/PUT/DELETE, and side-effecting
 * GETs such as `/offers/{DocumentNumber}/email`) are not emulated: they fail closed with the
 * wrapper's 404 `ErrorInformation`.
 *
 * No conformance fixture records these routes: they cite no case ids, are `unverified`, and use
 * minimal shapes named after the connector's read fields, rendered in the wire types the
 * connector's schemas accept (preferring the documented Fortnox wire type, such as numeric strings
 * in article list rows). Lists page with `page`/`limit` and `MetaInformation` where the connector
 * requires it; `lastmodified` is not emulated (the state tracks no modification times).
 *
 * @experimental
 */
import {
  base64Bytes,
  connectorRoute,
  contains,
  dateRange,
  invalidField,
  jsonResponse,
  matchesSearch,
  paginate,
  pdfResponse,
  resourceNotFound,
  resourceUrl,
  today,
  type FortnoxApiEnv,
  type FortnoxApiRoute,
  type RouteHandler,
  type SearchTable
} from './route-kit.ts'
import {
  compareNumbers,
  type FortnoxEmulatorArticle,
  type FortnoxEmulatorInboxFile,
  type FortnoxEmulatorInboxFolder,
  type FortnoxEmulatorInvoicePayment,
  type FortnoxEmulatorOffer,
  type FortnoxEmulatorPrice,
  type FortnoxEmulatorSupplierInvoicePayment
} from './read-state.ts'
import type { FortnoxEmulatorState } from './state.ts'

const pageKeys: ReadonlyArray<string> = ['page', 'limit']

/** One page of `items` under `envelope`, with `MetaInformation`. */
const pagedList = <A>(
  envelope: string,
  items: ReadonlyArray<A>,
  query: URLSearchParams,
  render: (item: A) => unknown
): Response => {
  const page = paginate(items, query)

  if (page instanceof Response) return page

  return jsonResponse(200, { [envelope]: page.items.map(render), MetaInformation: page.meta })
}

/** `{ <envelope>: item }`, or the generic not-found answer. */
const single = <A>(
  kind: string,
  envelope: string,
  item: A | undefined,
  render: (item: A) => unknown
): Response =>
  item === undefined ? resourceNotFound(kind) : jsonResponse(200, { [envelope]: render(item) })

const param = (params: Readonly<Record<string, string>>, name: string): string => params[name] ?? ''

/** A numeric string, or `null` (`WireNullableInt`: Fortnox docs examples send these as strings). */
const numericString = (value: number | null): string | null =>
  value === null ? null : String(value)

// Articles ---------------------------------------------------------------------------------------

/** `SalesPrice` is read-only: the base price (`FromQuantity` 0) in the PreSelected price list. */
const salesPrice = (state: FortnoxEmulatorState, articleNumber: string): number => {
  const defaultList = state.priceLists.find(priceList => priceList.PreSelected)

  return (
    state.prices.find(
      price =>
        price.PriceList === defaultList?.Code &&
        price.ArticleNumber === articleNumber &&
        price.FromQuantity === 0
    )?.Price ?? 0
  )
}

const articleUrl = (env: FortnoxApiEnv, articleNumber: string) =>
  resourceUrl(env, 'articles', articleNumber)

/** A single-article read: JSON numbers. */
const renderArticle = (
  state: FortnoxEmulatorState,
  env: FortnoxApiEnv,
  article: FortnoxEmulatorArticle
) => ({
  '@url': articleUrl(env, article.ArticleNumber),
  ...article,
  SalesPrice: salesPrice(state, article.ArticleNumber)
})

/** An article list row: quantities, prices, and VAT as numeric strings (Fortnox docs). */
const renderArticleRow = (
  state: FortnoxEmulatorState,
  env: FortnoxApiEnv,
  article: FortnoxEmulatorArticle
) => ({
  '@url': articleUrl(env, article.ArticleNumber),
  ArticleNumber: article.ArticleNumber,
  Description: article.Description,
  EAN: article.EAN,
  PurchasePrice: String(article.PurchasePrice),
  QuantityInStock: String(article.QuantityInStock),
  SalesPrice: String(salesPrice(state, article.ArticleNumber)),
  Unit: article.Unit,
  VAT: String(article.VAT)
})

const articleSearch = {
  articlenumber: (article, value) => article.ArticleNumber === value,
  description: (article, value) => contains(article.Description, value),
  ean: (article, value) => article.EAN === value,
  suppliernumber: (article, value) => article.SupplierNumber === value,
  manufacturer: (article, value) => contains(article.Manufacturer, value),
  manufacturerarticlenumber: (article, value) => article.ManufacturerArticleNumber === value
} satisfies SearchTable<FortnoxEmulatorArticle>

const listArticles: RouteHandler = (state, { query }, env) => {
  const filter = query.get('filter')

  if (filter !== null && filter !== 'active' && filter !== 'inactive') {
    return invalidField(`unknown article filter ${filter}.`)
  }

  return pagedList(
    'Articles',
    state.articles.filter(
      article =>
        (filter === null || article.Active === (filter === 'active')) &&
        matchesSearch(article, query, articleSearch)
    ),
    query,
    article => renderArticleRow(state, env, article)
  )
}

const getArticle: RouteHandler = (state, { params }, env) =>
  single(
    'article',
    'Article',
    state.articles.find(article => article.ArticleNumber === param(params, 'ArticleNumber')),
    article => renderArticle(state, env, article)
  )

// Price lists and prices -------------------------------------------------------------------------

const priceListSearch = {
  code: (priceList, value) => priceList.Code === value,
  comments: (priceList, value) => contains(priceList.Comments, value)
} satisfies SearchTable<FortnoxEmulatorState['priceLists'][number]>

const listPriceLists: RouteHandler = (state, { query }, env) =>
  pagedList(
    'PriceLists',
    state.priceLists.filter(priceList => matchesSearch(priceList, query, priceListSearch)),
    query,
    priceList => ({ '@url': resourceUrl(env, 'pricelists', priceList.Code), ...priceList })
  )

const getPriceList: RouteHandler = (state, { params }, env) =>
  single(
    'price list',
    'PriceList',
    state.priceLists.find(priceList => priceList.Code === param(params, 'Code')),
    priceList => ({ '@url': resourceUrl(env, 'pricelists', priceList.Code), ...priceList })
  )

const priceUrl = (env: FortnoxApiEnv, price: FortnoxEmulatorPrice) =>
  resourceUrl(env, 'prices', price.PriceList, price.ArticleNumber, String(price.FromQuantity))

/**
 * `GET /3/prices/sublist/{PriceList}/{ArticleNumber}`: one article's tiers in one price list, in
 * `FromQuantity` order. List rows leave out `Percent` and `Date`, as the connector notes.
 */
const listPrices: RouteHandler = (state, { params, query }, env) => {
  const priceList = param(params, 'PriceList')
  const articleNumber = param(params, 'ArticleNumber')

  if (!state.priceLists.some(candidate => candidate.Code === priceList)) {
    return resourceNotFound('price list')
  }

  if (!state.articles.some(article => article.ArticleNumber === articleNumber)) {
    return resourceNotFound('article')
  }

  return pagedList(
    'Prices',
    state.prices.filter(
      price => price.PriceList === priceList && price.ArticleNumber === articleNumber
    ),
    query,
    price => ({
      '@url': priceUrl(env, price),
      ArticleNumber: price.ArticleNumber,
      FromQuantity: price.FromQuantity,
      Price: price.Price,
      PriceList: price.PriceList
    })
  )
}

const plainDecimal = /^\d+(?:\.\d+)?$/u

const getPrice: RouteHandler = (state, { params }, env) => {
  const raw = param(params, 'FromQuantity')

  if (!plainDecimal.test(raw)) {
    return invalidField('FromQuantity must be a non-negative plain decimal.')
  }

  const fromQuantity = Number(raw)

  return single(
    'price',
    'Price',
    state.prices.find(
      price =>
        price.PriceList === param(params, 'PriceList') &&
        price.ArticleNumber === param(params, 'ArticleNumber') &&
        price.FromQuantity === fromQuantity
    ),
    price => ({ '@url': priceUrl(env, price), ...price })
  )
}

// Cost centers -----------------------------------------------------------------------------------

const listCostCenters: RouteHandler = (state, { query }, env) =>
  pagedList('CostCenters', state.costCenters, query, costCenter => ({
    '@url': resourceUrl(env, 'costcenters', costCenter.Code),
    ...costCenter
  }))

const getCostCenter: RouteHandler = (state, { params }, env) =>
  single(
    'cost center',
    'CostCenter',
    state.costCenters.find(costCenter => costCenter.Code === param(params, 'Code')),
    costCenter => ({ '@url': resourceUrl(env, 'costcenters', costCenter.Code), ...costCenter })
  )

// Payments ---------------------------------------------------------------------------------------

/**
 * A customer invoice payment. The invoice snapshot fields come from the held invoice;
 * `ModeOfPaymentAccount`, `VoucherNumber`, and `VoucherYear` are numeric strings, as Fortnox docs
 * examples send them.
 */
const renderInvoicePayment = (
  state: FortnoxEmulatorState,
  env: FortnoxApiEnv,
  payment: FortnoxEmulatorInvoicePayment
) => {
  const invoice = state.invoices.find(
    candidate => candidate.DocumentNumber === payment.InvoiceNumber
  )

  const mode = state.modesOfPayment.find(candidate => candidate.Code === payment.ModeOfPayment)

  return {
    '@url': resourceUrl(env, 'invoicepayments', payment.Number),
    Amount: payment.Amount,
    AmountCurrency: payment.AmountCurrency,
    Booked: payment.Booked,
    Currency: invoice?.Currency ?? null,
    CurrencyRate: invoice?.CurrencyRate ?? null,
    CurrencyUnit: invoice?.CurrencyUnit ?? null,
    InvoiceCustomerName: invoice?.CustomerName ?? null,
    InvoiceCustomerNumber: invoice?.CustomerNumber ?? null,
    InvoiceDueDate: invoice?.DueDate ?? null,
    InvoiceNumber: payment.InvoiceNumber,
    InvoiceOCR: invoice?.OCR ?? null,
    InvoiceTotal: invoice?.Total ?? null,
    ModeOfPayment: payment.ModeOfPayment,
    ModeOfPaymentAccount: numericString(mode?.AccountNumber ?? null),
    Number: payment.Number,
    PaymentDate: payment.PaymentDate,
    VoucherNumber: numericString(payment.VoucherNumber),
    VoucherSeries: payment.VoucherSeries,
    VoucherYear: numericString(payment.VoucherYear)
  }
}

const renderSupplierInvoicePayment = (
  env: FortnoxApiEnv,
  payment: FortnoxEmulatorSupplierInvoicePayment
) => ({
  '@url': resourceUrl(env, 'supplierinvoicepayments', payment.Number),
  ...payment,
  VoucherNumber: numericString(payment.VoucherNumber),
  VoucherYear: numericString(payment.VoucherYear)
})

/** Payments sorted by payment date, then number (the connector documents a payment-date order). */
const byPaymentDate = <A extends { readonly PaymentDate: string; readonly Number: string }>(
  payments: ReadonlyArray<A>
): ReadonlyArray<A> =>
  [...payments].sort(
    (left, right) =>
      compareNumbers(left.PaymentDate, right.PaymentDate) ||
      compareNumbers(left.Number, right.Number)
  )

const paymentQueryKeys: ReadonlyArray<string> = [...pageKeys, 'invoicenumber']

const listInvoicePayments: RouteHandler = (state, { query }, env) => {
  const invoiceNumber = query.get('invoicenumber')

  return pagedList(
    'InvoicePayments',
    byPaymentDate(
      state.invoicePayments.filter(
        payment => invoiceNumber === null || payment.InvoiceNumber === invoiceNumber
      )
    ),
    query,
    payment => renderInvoicePayment(state, env, payment)
  )
}

const getInvoicePayment: RouteHandler = (state, { params }, env) =>
  single(
    'invoice payment',
    'InvoicePayment',
    state.invoicePayments.find(payment => payment.Number === param(params, 'Number')),
    payment => renderInvoicePayment(state, env, payment)
  )

const listSupplierInvoicePayments: RouteHandler = (state, { query }, env) => {
  const invoiceNumber = query.get('invoicenumber')

  return pagedList(
    'SupplierInvoicePayments',
    byPaymentDate(
      state.supplierInvoicePayments.filter(
        payment => invoiceNumber === null || payment.InvoiceNumber === invoiceNumber
      )
    ),
    query,
    payment => renderSupplierInvoicePayment(env, payment)
  )
}

const getSupplierInvoicePayment: RouteHandler = (state, { params }, env) =>
  single(
    'supplier invoice payment',
    'SupplierInvoicePayment',
    state.supplierInvoicePayments.find(payment => payment.Number === param(params, 'Number')),
    payment => renderSupplierInvoicePayment(env, payment)
  )

// Offers -----------------------------------------------------------------------------------------

const offerUrl = (env: FortnoxApiEnv, documentNumber: string) =>
  resourceUrl(env, 'offers', documentNumber)

/** A single-offer read with its rows: JSON-number amounts, row `Quantity` a numeric string. */
const renderOffer = (env: FortnoxApiEnv, offer: FortnoxEmulatorOffer) => ({
  '@url': offerUrl(env, offer.DocumentNumber),
  ...offer
})

/** An offer list row: no rows and no `EmailInformation` (the connector reads rows from a get). */
const renderOfferRow = (env: FortnoxApiEnv, offer: FortnoxEmulatorOffer) => ({
  '@url': offerUrl(env, offer.DocumentNumber),
  Cancelled: offer.Cancelled,
  CostCenter: offer.CostCenter,
  Currency: offer.Currency,
  CustomerName: offer.CustomerName,
  CustomerNumber: offer.CustomerNumber,
  DocumentNumber: offer.DocumentNumber,
  OfferDate: offer.OfferDate,
  Project: offer.Project,
  Sent: offer.Sent,
  Total: offer.Total
})

type OfferFilter =
  | 'cancelled'
  | 'expired'
  | 'completed'
  | 'notcompleted'
  | 'ordercreated'
  | 'ordernotcreated'

const offerFilters: ReadonlyArray<OfferFilter> = [
  'cancelled',
  'expired',
  'completed',
  'notcompleted',
  'ordercreated',
  'ordernotcreated'
]

const isOfferFilter = (value: string): value is OfferFilter =>
  offerFilters.some(filter => filter === value)

/**
 * The emulator's offer filters, each a plain check of the stored fields (unverified: no fixture
 * records Fortnox's own selection): `expired` is an `ExpireDate` before today (the injectable
 * clock, UTC); `completed`/`notcompleted` follow `NotCompleted`; `ordercreated`/`ordernotcreated`
 * follow `OrderReference` (`"0"` means none).
 */
const matchesOfferFilter = (
  offer: FortnoxEmulatorOffer,
  filter: OfferFilter,
  env: FortnoxApiEnv
): boolean => {
  switch (filter) {
    case 'cancelled':
      return offer.Cancelled
    case 'expired':
      return offer.ExpireDate !== '' && offer.ExpireDate < today(env)
    case 'completed':
      return !offer.NotCompleted
    case 'notcompleted':
      return offer.NotCompleted
    case 'ordercreated':
      return offer.OrderReference !== '0' && offer.OrderReference !== ''
    case 'ordernotcreated':
      return offer.OrderReference === '0' || offer.OrderReference === ''
  }
}

const offerSearch = {
  customername: (offer, value) => contains(offer.CustomerName, value),
  customernumber: (offer, value) => offer.CustomerNumber === value,
  documentnumber: (offer, value) => offer.DocumentNumber === value,
  offerdate: (offer, value) => offer.OfferDate === value,
  ourreference: (offer, value) => contains(offer.OurReference, value),
  yourreference: (offer, value) => contains(offer.YourReference, value),
  costcenter: (offer, value) => offer.CostCenter === value,
  project: (offer, value) => offer.Project === value
} satisfies SearchTable<FortnoxEmulatorOffer>

const offerListQueryKeys: ReadonlyArray<string> = [
  ...pageKeys,
  'filter',
  'fromdate',
  'todate',
  ...Object.keys(offerSearch)
]

const listOffers: RouteHandler = (state, { query }, env) => {
  const filter = query.get('filter')

  if (filter !== null && !isOfferFilter(filter)) {
    return invalidField(`unknown offer filter ${filter}.`)
  }

  const range = dateRange(query)

  if (range instanceof Response) return range

  return pagedList(
    'Offers',
    state.offers.filter(
      offer =>
        (filter === null || matchesOfferFilter(offer, filter, env)) &&
        (range.from === null || offer.OfferDate >= range.from) &&
        (range.to === null || offer.OfferDate <= range.to) &&
        matchesSearch(offer, query, offerSearch)
    ),
    query,
    offer => renderOfferRow(env, offer)
  )
}

const findOffer = (state: FortnoxEmulatorState, params: Readonly<Record<string, string>>) =>
  state.offers.find(offer => offer.DocumentNumber === param(params, 'DocumentNumber'))

const getOffer: RouteHandler = (state, { params }, env) =>
  single('offer', 'Offer', findOffer(state, params), offer => renderOffer(env, offer))

/** The synthetic preview PDF (the invoice preview fixture's bytes); never marks the offer Sent. */
const previewOffer: RouteHandler = (state, { params }) =>
  findOffer(state, params) === undefined ? resourceNotFound('offer') : pdfResponse()

// Print templates --------------------------------------------------------------------------------

/** Unpaginated (no `MetaInformation`, no page/limit); `type` defaults to `invoice`. */
const listPrintTemplates: RouteHandler = (state, { query }) => {
  const type = query.get('type') ?? 'invoice'

  if (type !== 'invoice' && type !== 'offer' && type !== 'order') {
    return invalidField(`unknown print template type ${type}.`)
  }

  return jsonResponse(200, { PrintTemplates: state.printTemplates[type] })
}

// Inbox ------------------------------------------------------------------------------------------

const renderInboxFile = (env: FortnoxApiEnv, file: FortnoxEmulatorInboxFile) => ({
  '@url': resourceUrl(env, 'inbox', file.Id),
  ArchiveFileId: file.ArchiveFileId,
  Comments: file.Comments,
  Id: file.Id,
  Name: file.Name,
  Path: file.Path,
  Size: base64Bytes(file.ContentBase64).byteLength
})

const renderInboxFolder = (
  state: FortnoxEmulatorState,
  env: FortnoxApiEnv,
  folder: FortnoxEmulatorInboxFolder
) => ({
  Folder: {
    '@url': resourceUrl(env, 'inbox', folder.Id),
    Email: folder.Email,
    Files: state.inboxFiles
      .filter(file => file.FolderId === folder.Id)
      .map(file => renderInboxFile(env, file)),
    Folders: state.inboxFolders
      .filter(child => child.ParentId === folder.Id)
      .map(child => ({
        '@url': resourceUrl(env, 'inbox', child.Id),
        Email: child.Email,
        Id: child.Id,
        Name: child.Name
      })),
    Id: folder.Id,
    Name: folder.Name
  }
})

/** A folder Id answers its folder JSON; a file Id answers the file's bytes; anything else 404s. */
const inboxItem = (state: FortnoxEmulatorState, env: FortnoxApiEnv, id: string): Response => {
  const folder = state.inboxFolders.find(candidate => candidate.Id === id)

  if (folder !== undefined) return jsonResponse(200, renderInboxFolder(state, env, folder))

  const file = state.inboxFiles.find(candidate => candidate.Id === id)

  return file === undefined
    ? resourceNotFound('inbox item')
    : new Response(base64Bytes(file.ContentBase64), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
}

const getInboxRoot: RouteHandler = (state, _request, env) => inboxItem(state, env, 'root')

const getInboxItem: RouteHandler = (state, { params }, env) =>
  inboxItem(state, env, param(params, 'Id'))

// Settings ---------------------------------------------------------------------------------------

const getCompanySettings: RouteHandler = state =>
  jsonResponse(200, { CompanySettings: state.companySettings })

const getLockedPeriod: RouteHandler = state =>
  jsonResponse(200, { LockedPeriod: state.lockedPeriod })

/** Unpaginated: no `MetaInformation` (the connector models none). */
const listPredefinedAccounts: RouteHandler = state =>
  jsonResponse(200, { PreDefinedAccounts: state.predefinedAccounts })

// Fortnox spells the envelope `PreDefinedAccount`.
const getPredefinedAccount: RouteHandler = (state, { params }) =>
  single(
    'predefined account',
    'PreDefinedAccount',
    state.predefinedAccounts.find(account => account.Name === param(params, 'Name')),
    account => account
  )

/** Unpaginated: no `MetaInformation` (the connector models none). */
const listLabels: RouteHandler = state => jsonResponse(200, { Labels: state.labels })

// Settings registers -----------------------------------------------------------------------------

type Register<A extends { readonly Code: string }> = {
  readonly path: string
  readonly kind: string
  readonly listEnvelope: string
  readonly singleEnvelope: string
  readonly entries: (state: FortnoxEmulatorState) => ReadonlyArray<A>
  /** A list row; defaults to the stored entry. */
  readonly row?: (entry: A) => object
}

/** `GET /3/<path>` (paged, `MetaInformation`) and `GET /3/<path>/{Code}` for one register. */
const registerRoutes = <A extends { readonly Code: string }>(
  register: Register<A>
): ReadonlyArray<FortnoxApiRoute> => {
  const withUrl = (env: FortnoxApiEnv, entry: A, body: object) => ({
    '@url': resourceUrl(env, register.path, entry.Code),
    ...body
  })

  const list: RouteHandler = (state, { query }, env) =>
    pagedList(register.listEnvelope, register.entries(state), query, entry =>
      withUrl(env, entry, register.row === undefined ? entry : register.row(entry))
    )

  const get: RouteHandler = (state, { params }, env) =>
    single(
      register.kind,
      register.singleEnvelope,
      register.entries(state).find(entry => entry.Code === param(params, 'Code')),
      entry => withUrl(env, entry, entry)
    )

  return [
    connectorRoute('GET', `/${register.path}`, false, [], list, pageKeys),
    connectorRoute('GET', `/${register.path}/{Code}`, false, [], get)
  ]
}

// Profile ----------------------------------------------------------------------------------------

const getMe: RouteHandler = state => jsonResponse(200, { Me: state.me })

// Route table ------------------------------------------------------------------------------------

/**
 * The read-only routes, in manifest order. `GET /prices/sublist/{PriceList}/{ArticleNumber}` comes
 * before `GET /prices/{PriceList}/{ArticleNumber}/{FromQuantity}`, which also matches a sublist
 * path: both `matchFortnoxRoute` and the core take the first matching route.
 */
export const fortnoxReadRoutes: ReadonlyArray<FortnoxApiRoute> = [
  connectorRoute('GET', '/articles', false, [], listArticles, [
    ...pageKeys,
    'filter',
    ...Object.keys(articleSearch)
  ]),
  connectorRoute('GET', '/articles/{ArticleNumber}', false, [], getArticle),
  connectorRoute('GET', '/pricelists', false, [], listPriceLists, [
    ...pageKeys,
    ...Object.keys(priceListSearch)
  ]),
  connectorRoute('GET', '/pricelists/{Code}', false, [], getPriceList),
  connectorRoute(
    'GET',
    '/prices/sublist/{PriceList}/{ArticleNumber}',
    false,
    [],
    listPrices,
    pageKeys
  ),
  connectorRoute('GET', '/prices/{PriceList}/{ArticleNumber}/{FromQuantity}', false, [], getPrice),
  connectorRoute('GET', '/costcenters', false, [], listCostCenters, pageKeys),
  connectorRoute('GET', '/costcenters/{Code}', false, [], getCostCenter),
  connectorRoute('GET', '/invoicepayments', false, [], listInvoicePayments, paymentQueryKeys),
  connectorRoute('GET', '/invoicepayments/{Number}', false, [], getInvoicePayment),
  connectorRoute(
    'GET',
    '/supplierinvoicepayments',
    false,
    [],
    listSupplierInvoicePayments,
    paymentQueryKeys
  ),
  connectorRoute('GET', '/supplierinvoicepayments/{Number}', false, [], getSupplierInvoicePayment),
  connectorRoute('GET', '/offers', false, [], listOffers, offerListQueryKeys),
  connectorRoute('GET', '/offers/{DocumentNumber}', false, [], getOffer),
  connectorRoute('GET', '/offers/{DocumentNumber}/preview', false, [], previewOffer),
  connectorRoute('GET', '/printtemplates', false, [], listPrintTemplates, ['type']),
  connectorRoute('GET', '/inbox', false, [], getInboxRoot),
  connectorRoute('GET', '/inbox/{Id}', false, [], getInboxItem),
  connectorRoute('GET', '/settings/company', false, [], getCompanySettings),
  connectorRoute('GET', '/settings/lockedperiod', false, [], getLockedPeriod),
  connectorRoute('GET', '/predefinedaccounts', false, [], listPredefinedAccounts),
  connectorRoute('GET', '/predefinedaccounts/{Name}', false, [], getPredefinedAccount),
  connectorRoute('GET', '/labels', false, [], listLabels),
  ...registerRoutes({
    path: 'modesofpayments',
    kind: 'mode of payment',
    listEnvelope: 'ModesOfPayments',
    singleEnvelope: 'ModeOfPayment',
    entries: state => state.modesOfPayment,
    // Fortnox docs examples: list rows send AccountNumber as a string, single reads as a number.
    row: entry => ({ ...entry, AccountNumber: String(entry.AccountNumber) })
  }),
  ...registerRoutes({
    path: 'termsofpayments',
    kind: 'terms of payment',
    listEnvelope: 'TermsOfPayments',
    singleEnvelope: 'TermsOfPayment',
    entries: state => state.termsOfPayment
  }),
  ...registerRoutes({
    path: 'termsofdeliveries',
    kind: 'terms of delivery',
    listEnvelope: 'TermsOfDeliveries',
    singleEnvelope: 'TermsOfDelivery',
    entries: state => state.termsOfDelivery
  }),
  ...registerRoutes({
    path: 'wayofdeliveries',
    kind: 'way of delivery',
    listEnvelope: 'WayOfDeliveries',
    singleEnvelope: 'WayOfDelivery',
    entries: state => state.waysOfDelivery
  }),
  ...registerRoutes({
    path: 'units',
    kind: 'unit',
    listEnvelope: 'Units',
    singleEnvelope: 'Unit',
    entries: state => state.units
  }),
  connectorRoute('GET', '/me', false, [], getMe)
]
