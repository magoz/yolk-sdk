import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { OAuthCredential, type ConnectorAction } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  FortnoxDocumentNumber,
  downloadFortnoxInboxFile,
  downloadFortnoxOfferPreview,
  fortnoxApiBaseUrl,
  fortnoxArticleActions,
  fortnoxCostCenterActions,
  fortnoxGetArticleAction,
  fortnoxGetCompanySettingsAction,
  fortnoxGetCostCenterAction,
  fortnoxGetInboxFolderAction,
  fortnoxGetInvoicePaymentAction,
  fortnoxGetLockedPeriodAction,
  fortnoxGetModeOfPaymentAction,
  fortnoxGetOfferAction,
  fortnoxGetPredefinedAccountAction,
  fortnoxGetPriceAction,
  fortnoxGetPriceListAction,
  fortnoxGetProfileAction,
  fortnoxGetSupplierInvoicePaymentAction,
  fortnoxGetTermsOfDeliveryAction,
  fortnoxGetTermsOfPaymentAction,
  fortnoxGetUnitAction,
  fortnoxGetWayOfDeliveryAction,
  fortnoxInboxActions,
  fortnoxListArticlesAction,
  fortnoxListCostCentersAction,
  fortnoxListInvoicePaymentsAction,
  fortnoxListLabelsAction,
  fortnoxListModesOfPaymentAction,
  fortnoxListOffersAction,
  fortnoxListPredefinedAccountsAction,
  fortnoxListPriceListsAction,
  fortnoxListPricesAction,
  fortnoxListPrintTemplatesAction,
  fortnoxListSupplierInvoicePaymentsAction,
  fortnoxListTermsOfDeliveryAction,
  fortnoxListTermsOfPaymentAction,
  fortnoxListUnitsAction,
  fortnoxListWaysOfDeliveryAction,
  fortnoxOfferActions,
  fortnoxPaymentActions,
  fortnoxPriceActions,
  fortnoxPrintActions,
  fortnoxProfileActions,
  fortnoxSettingsActions,
  fortnoxSettingsRegisterActions
} from '@yolk-sdk/connectors/fortnox'
import { fortnoxConformanceIntegration } from '@yolk-sdk/connectors/fortnox/conformance'
import {
  emulatorEvidenceHeader,
  fortnoxEmulatorErrorCodes,
  fortnoxEmulatorRoutes,
  makeFortnoxEmulator,
  type FortnoxEmulator,
  type FortnoxEmulatorOptions,
  type FortnoxEmulatorSeed
} from '../src/fortnox.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = 'https://api.fortnox.se'

const token = 'synthetic-unit-test-token'

// 2026-09-29: offer 3 (ExpireDate 2026-08-31) has expired; offer 1 (2026-09-30) has not.
const now = Date.parse('2026-09-29T12:00:00.000Z')

const open: Array<FortnoxEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: FortnoxEmulatorOptions = {}): Promise<FortnoxEmulator> => {
  const created = await makeFortnoxEmulator({ now: () => now, ...options })

  open.push(created)

  return created
}

const call = (target: FortnoxEmulator, method: string, path: string): Promise<Response> =>
  target.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` }
    })
  )

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

const get = async (target: FortnoxEmulator, path: string): Promise<unknown> => {
  const response = await call(target, 'GET', path)

  expect(response.status, path).toBe(200)
  expect(response.headers.get(emulatorEvidenceHeader), path).toBe('unverified')

  return response.json()
}

/** The `key` values of the list under `envelope` at `path`. */
const keys = async (
  target: FortnoxEmulator,
  path: string,
  envelope: string,
  key: string
): Promise<unknown> => {
  const items = field(await get(target, path), envelope)

  return Array.isArray(items) ? items.map(item => field(item, key)) : items
}

const errorCode = async (response: Response): Promise<unknown> =>
  field(field(await response.json(), 'ErrorInformation'), 'code')

/** The real Fortnox connector, routed in process to `target`. */
const connectorLayer = (target: FortnoxEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(
        InProcessHttpClient.layer([
          EmulatorRoute.handler(new URL(fortnoxApiBaseUrl).origin, target.fetch)
        ])
      )
    ),
    staticCredentialResolverLayer(
      OAuthCredential.make({
        provider: 'fortnox',
        accessToken: token,
        expiresAt: 4_000_000_000_000
      })
    )
  )

describe('read-only routes', () => {
  it.effect('answer every list and single read in its envelope', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const [path, envelope] of [
        ['/3/articles', 'Articles'],
        ['/3/articles/KIT-1', 'Article'],
        ['/3/pricelists', 'PriceLists'],
        ['/3/pricelists/A', 'PriceList'],
        ['/3/prices/sublist/A/KIT-1', 'Prices'],
        ['/3/prices/A/KIT-1/10', 'Price'],
        ['/3/costcenters', 'CostCenters'],
        ['/3/costcenters/CC9', 'CostCenter'],
        ['/3/invoicepayments', 'InvoicePayments'],
        ['/3/invoicepayments/1', 'InvoicePayment'],
        ['/3/supplierinvoicepayments', 'SupplierInvoicePayments'],
        ['/3/supplierinvoicepayments/1', 'SupplierInvoicePayment'],
        ['/3/offers', 'Offers'],
        ['/3/offers/1', 'Offer'],
        ['/3/printtemplates', 'PrintTemplates'],
        ['/3/inbox', 'Folder'],
        ['/3/inbox/inbox_s', 'Folder'],
        ['/3/settings/company', 'CompanySettings'],
        ['/3/settings/lockedperiod', 'LockedPeriod'],
        ['/3/predefinedaccounts', 'PreDefinedAccounts'],
        ['/3/predefinedaccounts/SALES', 'PreDefinedAccount'],
        ['/3/labels', 'Labels'],
        ['/3/modesofpayments', 'ModesOfPayments'],
        ['/3/modesofpayments/BG', 'ModeOfPayment'],
        ['/3/termsofpayments', 'TermsOfPayments'],
        ['/3/termsofpayments/30', 'TermsOfPayment'],
        ['/3/termsofdeliveries', 'TermsOfDeliveries'],
        ['/3/termsofdeliveries/EXW', 'TermsOfDelivery'],
        ['/3/wayofdeliveries', 'WayOfDeliveries'],
        ['/3/wayofdeliveries/P', 'WayOfDelivery'],
        ['/3/units', 'Units'],
        ['/3/units/st', 'Unit'],
        ['/3/me', 'Me']
      ] as const) {
        expect(field(await get(target, path), envelope), path).toBeDefined()
      }

      // Every read-only route is a ledgered, unverified GET; nothing was written.
      expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
    })
  )

  it.effect('render the wire types the connector schemas accept', () =>
    Effect.promise(async () => {
      const target = await emulator()

      // Article list rows send quantities, prices, and VAT as numeric strings; a single read as
      // numbers. SalesPrice is the PreSelected price list's base price.
      expect(field(await get(target, '/3/articles?articlenumber=KIT-1'), 'Articles')).toEqual([
        {
          '@url': `${origin}/3/articles/KIT-1`,
          ArticleNumber: 'KIT-1',
          Description: 'Workshop kit (synthetic)',
          EAN: '2000000000015',
          PurchasePrice: '120',
          QuantityInStock: '15',
          SalesPrice: '250',
          Unit: 'st',
          VAT: '25'
        }
      ])
      expect(field(await get(target, '/3/articles/KIT-1'), 'Article')).toMatchObject({
        SalesPrice: 250,
        QuantityInStock: 15,
        VAT: 25,
        Active: true,
        Type: 'STOCK'
      })

      // Mode of payment: AccountNumber a string in list rows, a number in a single read.
      expect(await keys(target, '/3/modesofpayments', 'ModesOfPayments', 'AccountNumber')).toEqual([
        '1930',
        '1910'
      ])
      expect(
        field(field(await get(target, '/3/modesofpayments/BG'), 'ModeOfPayment'), 'AccountNumber')
      ).toBe(1930)

      // An invoice payment carries its held invoice's snapshot; voucher fields numeric strings.
      expect(field(await get(target, '/3/invoicepayments/1'), 'InvoicePayment')).toMatchObject({
        Number: '1',
        InvoiceNumber: '101',
        Amount: 1250,
        Booked: true,
        Currency: 'SEK',
        InvoiceCustomerNumber: '1001',
        InvoiceCustomerName: 'Example Customer AB',
        InvoiceTotal: 1250,
        ModeOfPayment: 'BG',
        ModeOfPaymentAccount: '1930',
        VoucherNumber: '1',
        VoucherYear: '3'
      })

      // Offers: totals from the rows (9500 + 450 net, 25% VAT, whole kronor); row Quantity a
      // numeric string; "0" references mean none.
      const offer = field(await get(target, '/3/offers/1'), 'Offer')

      expect(offer).toMatchObject({
        CustomerName: 'Example Customer AB',
        Net: 9950,
        TotalVAT: 2487.5,
        Total: 12438,
        OrderReference: '0',
        InvoiceReference: '0',
        EmailInformation: { EmailAddressTo: 'billing@example.test' }
      })
      expect(field(offer, 'OfferRows')).toMatchObject([
        { RowId: 1, Quantity: '10.00', Total: 9500 },
        { RowId: 2, Quantity: '2.00', Total: 450 }
      ])
      expect(await keys(target, '/3/offers?documentnumber=1', 'Offers', 'DocumentNumber')).toEqual([
        '1'
      ])
      expect(await keys(target, '/3/offers', 'Offers', 'OfferRows')).toEqual([
        undefined,
        undefined,
        undefined
      ])

      // Print templates, predefined accounts, and labels carry no MetaInformation.
      for (const path of ['/3/printtemplates', '/3/predefinedaccounts', '/3/labels']) {
        expect(field(await get(target, path), 'MetaInformation'), path).toBeUndefined()
      }
    })
  )

  it.effect('paginate with MetaInformation', () =>
    Effect.promise(async () => {
      const target = await emulator()

      const page = await get(target, '/3/articles?limit=1&page=2')

      expect(field(page, 'Articles')).toMatchObject([{ ArticleNumber: 'SRV-1' }])
      expect(field(page, 'MetaInformation')).toEqual({
        '@CurrentPage': 2,
        '@TotalPages': 3,
        '@TotalResources': 3
      })

      for (const path of [
        '/3/pricelists?limit=1',
        '/3/prices/sublist/A/KIT-1?limit=1',
        '/3/costcenters?limit=1',
        '/3/offers?limit=1',
        '/3/units?limit=1',
        '/3/termsofpayments?limit=1'
      ]) {
        const meta = field(await get(target, path), 'MetaInformation')

        expect(field(meta, '@CurrentPage'), path).toBe(1)
        expect(field(meta, '@TotalPages'), path).toBe(field(meta, '@TotalResources'))
      }

      expect((await call(target, 'GET', '/3/units?limit=501')).status).toBe(400)
      expect((await call(target, 'GET', '/3/offers?page=0')).status).toBe(400)
    })
  )

  it.effect('filter and search lists', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const [path, envelope, key, expected] of [
        ['/3/articles?filter=inactive', 'Articles', 'ArticleNumber', ['SRV-OLD']],
        ['/3/articles?filter=active', 'Articles', 'ArticleNumber', ['KIT-1', 'SRV-1']],
        ['/3/articles?description=CONSULTING', 'Articles', 'ArticleNumber', ['SRV-1']],
        ['/3/articles?ean=2000000000015', 'Articles', 'ArticleNumber', ['KIT-1']],
        ['/3/articles?manufacturer=tools', 'Articles', 'ArticleNumber', ['KIT-1']],
        ['/3/articles?manufacturerarticlenumber=EX-KIT-1', 'Articles', 'ArticleNumber', ['KIT-1']],
        ['/3/articles?suppliernumber=1', 'Articles', 'ArticleNumber', []],
        ['/3/pricelists?code=B', 'PriceLists', 'Code', ['B']],
        ['/3/pricelists?comments=reseller', 'PriceLists', 'Code', ['B']],
        ['/3/prices/sublist/A/KIT-1', 'Prices', 'FromQuantity', [0, 10]],
        ['/3/prices/sublist/B/SRV-1', 'Prices', 'FromQuantity', []],
        ['/3/invoicepayments?invoicenumber=101', 'InvoicePayments', 'Number', ['1']],
        ['/3/invoicepayments?invoicenumber=102', 'InvoicePayments', 'Number', []],
        ['/3/supplierinvoicepayments?invoicenumber=1', 'SupplierInvoicePayments', 'Number', ['1']],
        ['/3/offers?filter=cancelled', 'Offers', 'DocumentNumber', ['3']],
        ['/3/offers?filter=expired', 'Offers', 'DocumentNumber', ['3']],
        ['/3/offers?filter=completed', 'Offers', 'DocumentNumber', ['1', '3']],
        ['/3/offers?filter=notcompleted', 'Offers', 'DocumentNumber', ['2']],
        ['/3/offers?filter=ordercreated', 'Offers', 'DocumentNumber', []],
        ['/3/offers?filter=ordernotcreated', 'Offers', 'DocumentNumber', ['1', '2', '3']],
        ['/3/offers?fromdate=2026-09-01', 'Offers', 'DocumentNumber', ['1', '2']],
        ['/3/offers?todate=2026-09-01', 'Offers', 'DocumentNumber', ['1', '3']],
        ['/3/offers?customernumber=1002', 'Offers', 'DocumentNumber', ['2']],
        ['/3/offers?customername=customer', 'Offers', 'DocumentNumber', ['1', '3']],
        ['/3/offers?offerdate=2026-09-20', 'Offers', 'DocumentNumber', ['2']],
        ['/3/offers?ourreference=seller', 'Offers', 'DocumentNumber', ['1']],
        ['/3/offers?yourreference=nobody', 'Offers', 'DocumentNumber', []],
        ['/3/offers?costcenter=CC1', 'Offers', 'DocumentNumber', ['1']],
        ['/3/offers?project=P1', 'Offers', 'DocumentNumber', []],
        [
          '/3/printtemplates',
          'PrintTemplates',
          'Template',
          ['invoice-standard', 'invoice-reminder']
        ],
        ['/3/printtemplates?type=offer', 'PrintTemplates', 'Template', ['offer-standard']],
        ['/3/printtemplates?type=order', 'PrintTemplates', 'Template', ['order-standard']]
      ] as const) {
        expect(await keys(target, path, envelope, key), path).toEqual(expected)
      }

      for (const path of [
        '/3/articles?filter=all',
        '/3/offers?filter=overdue',
        '/3/offers?fromdate=yesterday',
        '/3/printtemplates?type=receipt',
        '/3/prices/A/KIT-1/1e1',
        '/3/prices/A/KIT-1/-1'
      ]) {
        const response = await call(target, 'GET', path)

        expect(response.status, path).toBe(400)
        expect(await errorCode(response), path).toBe(fortnoxEmulatorErrorCodes.invalidField)
      }
    })
  )

  it.effect('answer a 404 ErrorInformation for keys the state does not hold', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const path of [
        '/3/articles/NOPE',
        '/3/pricelists/Z',
        '/3/prices/sublist/Z/KIT-1',
        '/3/prices/sublist/A/NOPE',
        '/3/prices/A/KIT-1/5',
        '/3/costcenters/CC404',
        '/3/invoicepayments/404',
        '/3/supplierinvoicepayments/404',
        '/3/offers/404',
        '/3/offers/404/preview',
        '/3/inbox/00000000-0000-4000-8000-000000000404',
        '/3/predefinedaccounts/NOPE',
        '/3/modesofpayments/NOPE',
        '/3/termsofpayments/NOPE',
        '/3/termsofdeliveries/NOPE',
        '/3/wayofdeliveries/NOPE',
        '/3/units/NOPE'
      ]) {
        const response = await call(target, 'GET', path)

        expect(response.status, path).toBe(404)
        expect(response.headers.get(emulatorEvidenceHeader), path).toBe('unverified')
        expect(await errorCode(response), path).toBe(fortnoxEmulatorErrorCodes.resourceNotFound)
      }
    })
  )

  it.effect('reject query keys they do not emulate, lastmodified included', () =>
    Effect.promise(async () => {
      const target = await emulator()

      for (const path of [
        '/3/articles?sortby=description',
        '/3/articles/KIT-1?page=1',
        '/3/pricelists?description=standard',
        '/3/prices/sublist/A/KIT-1?fromquantity=0',
        '/3/costcenters?filter=active',
        '/3/invoicepayments?customernumber=1001',
        '/3/offers?sent=true',
        '/3/offers/1/preview?download=1',
        '/3/printtemplates?page=1',
        '/3/inbox?folderid=root',
        '/3/settings/company?x=1',
        '/3/predefinedaccounts?limit=10',
        '/3/labels?page=1',
        '/3/units?search=h',
        '/3/me?x=1',
        '/3/articles?lastmodified=2026-09-01%2000:00',
        '/3/costcenters?lastmodified=2026-09-01%2000:00'
      ]) {
        const response = await call(target, 'GET', path)

        expect(response.status, path).toBe(400)
        expect(await errorCode(response), path).toBe(fortnoxEmulatorErrorCodes.unsupportedQuery)
      }

      const lastModified = await call(target, 'GET', '/3/offers?lastmodified=2026-09-01')

      expect(field(field(await lastModified.json(), 'ErrorInformation'), 'message')).toContain(
        'does not track modification times'
      )
    })
  )

  it.effect('leave every write unemulated: a ledgered 404 that changes nothing', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const before = target.snapshot()

      const writes = [
        ['POST', '/3/articles'],
        ['PUT', '/3/articles/KIT-1'],
        ['DELETE', '/3/articles/KIT-1'],
        ['POST', '/3/pricelists'],
        ['PUT', '/3/pricelists/A'],
        ['POST', '/3/prices'],
        ['PUT', '/3/prices/A/KIT-1/0'],
        ['DELETE', '/3/prices/A/KIT-1/0'],
        ['POST', '/3/costcenters'],
        ['DELETE', '/3/costcenters/CC1'],
        ['POST', '/3/invoicepayments'],
        ['PUT', '/3/invoicepayments/1/bookkeep'],
        ['DELETE', '/3/supplierinvoicepayments/1'],
        ['POST', '/3/offers'],
        ['PUT', '/3/offers/1'],
        ['PUT', '/3/offers/1/createorder'],
        ['PUT', '/3/offers/1/createinvoice'],
        ['PUT', '/3/offers/1/cancel'],
        ['PUT', '/3/offers/1/externalprint'],
        // Side-effecting GETs stay unemulated too.
        ['GET', '/3/offers/1/email'],
        ['GET', '/3/offers/1/print'],
        ['POST', '/3/inbox'],
        ['DELETE', '/3/inbox/00000000-0000-4000-8000-000000000001'],
        ['PUT', '/3/settings/company'],
        ['PUT', '/3/predefinedaccounts/SALES'],
        ['POST', '/3/labels'],
        ['PUT', '/3/labels/1'],
        ['DELETE', '/3/labels/1'],
        ['POST', '/3/modesofpayments'],
        ['PUT', '/3/termsofpayments/30'],
        ['DELETE', '/3/wayofdeliveries/P'],
        ['POST', '/3/termsofdeliveries'],
        ['PUT', '/3/units/h'],
        ['GET', '/3/labels/1'],
        ['GET', '/3/orders']
      ] as const

      for (const [method, path] of writes) {
        const response = await call(target, method, path)

        expect(response.status, `${method} ${path}`).toBe(404)
        expect(response.headers.get(emulatorEvidenceHeader), `${method} ${path}`).toBeNull()
        expect(await errorCode(response), `${method} ${path}`).toBe(
          fortnoxEmulatorErrorCodes.unknownRoute
        )
      }

      expect(target.snapshot()).toEqual(before)
      expect(target.coverage().unknownRouteRequests).toBe(writes.length)
    })
  )

  it.effect('resolve the price sublist path to the sublist route, not the price route', () =>
    Effect.promise(async () => {
      const target = await emulator()

      expect(field(await get(target, '/3/prices/sublist/A/KIT-1'), 'Prices')).toBeDefined()
      expect(field(await get(target, '/3/prices/A/KIT-1/10'), 'Price')).toEqual({
        '@url': `${origin}/3/prices/A/KIT-1/10`,
        PriceList: 'A',
        ArticleNumber: 'KIT-1',
        FromQuantity: 10,
        Price: 220,
        Percent: 0,
        Date: '2026-08-01'
      })
      // A price list whose Code is `sublist` is only readable through the sublist route.
      expect((await call(target, 'GET', '/3/prices/sublist/KIT-1/0')).status).toBe(404)

      expect(target.ledger.entries().map(entry => entry.route)).toEqual([
        '/3/prices/sublist/{PriceList}/{ArticleNumber}',
        '/3/prices/{PriceList}/{ArticleNumber}/{FromQuantity}',
        '/3/prices/sublist/{PriceList}/{ArticleNumber}'
      ])
    })
  )

  it.effect('serve inbox folders as JSON and inbox files as bytes', () =>
    Effect.promise(async () => {
      const target = await emulator()
      const root = field(await get(target, '/3/inbox'), 'Folder')

      expect(field(root, 'Id')).toBe('root')
      expect(field(root, 'Files')).toEqual([])

      const folders = field(root, 'Folders')

      expect(Array.isArray(folders) ? folders.map(folder => field(folder, 'Id')) : []).toEqual([
        'inbox_a',
        'inbox_d',
        'inbox_s',
        'inbox_v',
        'inbox_b',
        'inbox_l',
        'inbox_kf',
        'inbox_o',
        'inbox_of'
      ])
      expect(field(await get(target, '/3/inbox/root'), 'Folder')).toEqual(root)

      const supplier = field(await get(target, '/3/inbox/inbox_s'), 'Folder')
      const files = field(supplier, 'Files')
      const file = Array.isArray(files) ? files[0] : undefined
      const expected = 'Synthetic supplier invoice from Example Supplier AB (example.test).\n'

      expect(file).toMatchObject({
        Id: '00000000-0000-4000-8000-000000000001',
        Name: 'supplier-invoice-synthetic.txt',
        Size: new TextEncoder().encode(expected).byteLength,
        ArchiveFileId: '00000000-0000-4000-8000-000000000101'
      })
      expect(field(supplier, 'Folders')).toEqual([])

      const bytes = await call(target, 'GET', '/3/inbox/00000000-0000-4000-8000-000000000001')

      expect(bytes.status).toBe(200)
      expect(bytes.headers.get('content-type')).toBe('application/octet-stream')
      expect(bytes.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await bytes.text()).toBe(expected)

      const preview = await call(target, 'GET', '/3/offers/2/preview')

      expect(preview.headers.get('content-type')).toBe('application/pdf')
      expect(new TextDecoder().decode((await preview.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
      // The preview marks nothing Sent.
      expect(target.snapshot().offers.find(offer => offer.DocumentNumber === '2')?.Sent).toBe(false)
    })
  )

  it.effect('answer a matching fault only for a read they would answer', () =>
    Effect.promise(async () => {
      const target = await emulator()

      target.faults.add({ kind: 'status', status: 429, match: { path: '/3/articles*' }, count: 1 })

      // A refusal (404) uses up no fault; the next valid read gets it.
      expect((await call(target, 'GET', '/3/articles/NOPE')).status).toBe(404)
      expect((await call(target, 'GET', '/3/articles/KIT-1')).status).toBe(429)
      expect((await call(target, 'GET', '/3/articles/KIT-1')).status).toBe(200)
    })
  )
})

describe('read-only seeds and profiles', () => {
  it.effect('default seed is mutually consistent and every part can be replaced', () =>
    Effect.promise(async () => {
      const state = (await emulator()).snapshot()
      const articles = state.articles.map(article => article.ArticleNumber)

      expect(state.prices.every(price => articles.includes(price.ArticleNumber))).toBe(true)
      expect(
        state.invoicePayments.every(payment =>
          state.invoices.some(invoice => invoice.DocumentNumber === payment.InvoiceNumber)
        )
      ).toBe(true)
      expect(
        state.offers.every(offer =>
          state.customers.some(customer => customer.CustomerNumber === offer.CustomerNumber)
        )
      ).toBe(true)

      const custom = await emulator({
        seed: {
          articles: [{ ArticleNumber: 'X1', Description: 'Synthetic X' }],
          priceLists: [{ Code: 'A', Description: 'A', Comments: '', PreSelected: true }],
          prices: [
            {
              PriceList: 'A',
              ArticleNumber: 'X1',
              FromQuantity: 0,
              Price: 10,
              Percent: 0,
              Date: '2026-09-01'
            }
          ],
          offers: [{ DocumentNumber: '9', CustomerNumber: '1002' }],
          labels: [],
          me: {
            Id: 'synthetic-user-2',
            Name: 'Other User',
            Email: 'other@example.test',
            Locale: 'en_US',
            SysAdmin: false
          }
        }
      })

      expect(field(await get(custom, '/3/articles/X1'), 'Article')).toMatchObject({
        SalesPrice: 10,
        Unit: '',
        Active: true
      })
      expect(await keys(custom, '/3/offers', 'Offers', 'CustomerName')).toEqual([
        'Example Trading AB'
      ])
      expect(field(await get(custom, '/3/labels'), 'Labels')).toEqual([])
      expect(field(field(await get(custom, '/3/me'), 'Me'), 'Name')).toBe('Other User')
      // The parts not given keep the profile's.
      expect(await keys(custom, '/3/units', 'Units', 'Code')).toEqual(['h', 'st'])

      // Reset restores this seed (the state round-trips through the state schema).
      const seeded = custom.snapshot()

      await custom.seed({ profile: 'empty-company' })
      await custom.reset()
      expect(custom.snapshot().articles).toEqual([])
      expect(custom.snapshot()).not.toEqual(seeded)
    })
  )

  it.effect('reject seeds with duplicates or dangling references', () =>
    Effect.promise(async () => {
      const cases: ReadonlyArray<readonly [FortnoxEmulatorSeed, string]> = [
        [
          {
            articles: [
              { ArticleNumber: 'A1', Description: 'x' },
              { ArticleNumber: 'A1', Description: 'y' }
            ],
            prices: [],
            offers: []
          },
          'duplicate ArticleNumber A1'
        ],
        [{ articles: [], offers: [] }, 'references missing article'],
        [
          {
            customers: [],
            invoices: [],
            offers: [{ DocumentNumber: '9', CustomerNumber: '1001' }]
          },
          'offer 9 references missing customer 1001'
        ],
        [
          {
            invoices: [],
            invoicePayments: [
              { Number: '9', InvoiceNumber: '101', Amount: 1, PaymentDate: '2026-09-30' }
            ]
          },
          'invoice payment 9 references missing invoice 101'
        ],
        [{ units: [] }, 'references missing unit'],
        [{ costCenters: [] }, 'references missing cost center'],
        [{ modesOfPayment: [] }, 'references missing mode of payment'],
        [
          {
            priceLists: [
              { Code: 'A', Description: 'A', Comments: '', PreSelected: true },
              { Code: 'B', Description: 'B', Comments: '', PreSelected: true }
            ]
          },
          'more than one PreSelected'
        ],
        [{ priceLists: [] }, 'references missing price list'],
        [
          {
            inboxFiles: [{ Id: 'f1', Name: 'f', FolderId: 'nowhere', ContentBase64: 'AAAA' }]
          },
          'references missing folder nowhere'
        ],
        [
          { inboxFiles: [{ Id: 'f1', Name: 'f', FolderId: 'root', ContentBase64: 'AAA' }] },
          'not canonical standard base64'
        ],
        [
          {
            inboxFolders: [
              { Id: 'root', Name: 'Inbox', Email: '', ParentId: null },
              { Id: 'a', Name: 'a', Email: '', ParentId: 'b' },
              { Id: 'b', Name: 'b', Email: '', ParentId: 'a' }
            ],
            inboxFiles: []
          },
          'not reachable from root'
        ],
        [{ inboxFolders: [], inboxFiles: [] }, 'needs a root folder'],
        [
          {
            labels: [
              { Id: 1, Description: 'a' },
              { Id: 1, Description: 'b' }
            ]
          },
          'duplicate label Id 1'
        ],
        [
          {
            units: [
              { Code: 'h', Description: 'h', CodeEnglish: 'h' },
              { Code: 'h', Description: 'h', CodeEnglish: 'h' }
            ]
          },
          'duplicate unit Code h'
        ]
      ]

      for (const [seed, message] of cases) {
        await expect(makeFortnoxEmulator({ seed }), JSON.stringify(seed)).rejects.toThrow(message)
      }

      // Replacing customers or invoices alone starts their profile dependents empty.
      for (const seed of [{ customers: [], invoices: [] }, { invoices: [] }]) {
        const emulator = await makeFortnoxEmulator({ seed })
        await emulator.close()
      }

      // Schema-level checks: a FromQuantity the connector cannot put in a path, a lowercase
      // predefined account name, an unknown key, a VAT-inclusive offer (totals would be wrong).
      for (const seed of [
        {
          prices: [
            {
              PriceList: 'A',
              ArticleNumber: 'KIT-1',
              FromQuantity: 1e21,
              Price: 1,
              Percent: 0,
              Date: '2026-09-01'
            }
          ]
        },
        { predefinedAccounts: [{ Name: 'sales', Account: 3001 }] },
        { articles: [{ ArticleNumber: 'A', Description: 'a', SalesPrice: 1 }] },
        { offers: [{ DocumentNumber: '9', CustomerNumber: '1001', VATIncluded: true }] }
      ]) {
        await expect(
          makeFortnoxEmulator({ seed: JSON.parse(JSON.stringify(seed)) }),
          JSON.stringify(seed)
        ).rejects.toThrow('Invalid Fortnox emulator seed')
      }
    })
  )

  it.effect(
    'profiles: an empty company keeps settings and folders; no booked invoices, no payments',
    () =>
      Effect.promise(async () => {
        const empty = await emulator({ seed: { profile: 'empty-company' } })

        for (const [path, envelope] of [
          ['/3/articles', 'Articles'],
          ['/3/pricelists', 'PriceLists'],
          ['/3/costcenters', 'CostCenters'],
          ['/3/invoicepayments', 'InvoicePayments'],
          ['/3/supplierinvoicepayments', 'SupplierInvoicePayments'],
          ['/3/offers', 'Offers'],
          ['/3/labels', 'Labels']
        ] as const) {
          expect(field(await get(empty, path), envelope), path).toEqual([])
        }

        expect(field(field(await get(empty, '/3/inbox/inbox_s'), 'Folder'), 'Files')).toEqual([])
        expect(await keys(empty, '/3/units', 'Units', 'Code')).toEqual(['h', 'st'])
        expect(field(await get(empty, '/3/me'), 'Me')).toBeDefined()

        const unbooked = await emulator({ seed: { profile: 'no-booked-invoices' } })

        expect(field(await get(unbooked, '/3/invoicepayments'), 'InvoicePayments')).toEqual([])
        expect(await keys(unbooked, '/3/offers', 'Offers', 'DocumentNumber')).toEqual([
          '1',
          '2',
          '3'
        ])
      })
  )
})

const budget = { maxBytes: 1024 * 1024, maxMetadataBytes: 64 * 1024, maxErrorBodyBytes: 4096 }

/** Every connector read action of the new Fortnox modules (writes are not emulated). */
const readActionIds = [
  ...fortnoxArticleActions,
  ...fortnoxPriceActions,
  ...fortnoxCostCenterActions,
  ...fortnoxPaymentActions,
  ...fortnoxOfferActions,
  ...fortnoxPrintActions,
  ...fortnoxInboxActions,
  ...fortnoxSettingsActions,
  ...fortnoxSettingsRegisterActions,
  ...fortnoxProfileActions
].flatMap(action => (action.access === 'read' ? [action.id] : []))

const run = <R, E>(action: ConnectorAction<R, E>, input: unknown) =>
  action
    .execute({ integration: fortnoxConformanceIntegration, input })
    .pipe(Effect.map(result => ({ id: action.id, result })))

describe('the real connector against the read-only routes', () => {
  it.effect('every read action runs in process and decodes the emulator answer', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      const results = yield* Effect.all([
        run(fortnoxListArticlesAction, {}),
        run(fortnoxListArticlesAction, {
          filter: 'active',
          search: { field: 'description', value: 'kit' },
          limit: 1
        }),
        run(fortnoxGetArticleAction, { articleNumber: 'KIT-1' }),
        run(fortnoxListPriceListsAction, { search: { field: 'code', value: 'A' } }),
        run(fortnoxGetPriceListAction, { code: 'A' }),
        run(fortnoxListPricesAction, { priceList: 'A', articleNumber: 'KIT-1', page: 1 }),
        run(fortnoxGetPriceAction, { priceList: 'A', articleNumber: 'KIT-1', fromQuantity: 10 }),
        run(fortnoxListCostCentersAction, { limit: 2 }),
        run(fortnoxGetCostCenterAction, { code: 'CC9' }),
        run(fortnoxListInvoicePaymentsAction, {
          search: { field: 'invoicenumber', value: '101' }
        }),
        run(fortnoxGetInvoicePaymentAction, { paymentNumber: '1' }),
        run(fortnoxListSupplierInvoicePaymentsAction, {}),
        run(fortnoxGetSupplierInvoicePaymentAction, { paymentNumber: '1' }),
        run(fortnoxListOffersAction, {
          filter: 'notcompleted',
          fromDate: '2026-09-01',
          toDate: '2026-09-30'
        }),
        run(fortnoxListOffersAction, { search: { field: 'customernumber', value: '1001' } }),
        run(fortnoxGetOfferAction, { documentNumber: '1' }),
        run(fortnoxListPrintTemplatesAction, {}),
        run(fortnoxListPrintTemplatesAction, { type: 'offer' }),
        run(fortnoxGetInboxFolderAction, {}),
        run(fortnoxGetInboxFolderAction, { folderId: 'inbox_v' }),
        run(fortnoxGetCompanySettingsAction, {}),
        run(fortnoxGetLockedPeriodAction, {}),
        run(fortnoxListPredefinedAccountsAction, {}),
        run(fortnoxGetPredefinedAccountAction, { name: 'SALES' }),
        run(fortnoxListLabelsAction, {}),
        run(fortnoxListModesOfPaymentAction, {}),
        run(fortnoxGetModeOfPaymentAction, { code: 'BG' }),
        run(fortnoxListTermsOfPaymentAction, { limit: 1, page: 2 }),
        run(fortnoxGetTermsOfPaymentAction, { code: '30' }),
        run(fortnoxListTermsOfDeliveryAction, {}),
        run(fortnoxGetTermsOfDeliveryAction, { code: 'EXW' }),
        run(fortnoxListWaysOfDeliveryAction, {}),
        run(fortnoxGetWayOfDeliveryAction, { code: 'P' }),
        run(fortnoxListUnitsAction, {}),
        run(fortnoxGetUnitAction, { code: 'st' }),
        run(fortnoxGetProfileAction, {})
      ]).pipe(Effect.provide(connectorLayer(target)))

      // Every new read action is covered, and every one decoded a success.
      expect(new Set(results.map(({ id }) => id))).toEqual(new Set(readActionIds))

      for (const { id, result } of results) {
        expect(result, id).toMatchObject({ _tag: 'Success' })
      }

      const value = (index: number): unknown => {
        const entry = results[index]

        return entry !== undefined && Predicate.isTagged(entry.result, 'Success')
          ? entry.result.value
          : undefined
      }

      expect(value(2)).toMatchObject({ ArticleNumber: 'KIT-1', SalesPrice: 250, VAT: 25 })
      // The list row's numeric strings decode to numbers.
      expect(field(value(1), 'pagination')).toMatchObject({ currentPage: 1, totalResources: 1 })
      expect(value(6)).toMatchObject({ FromQuantity: 10, Price: 220 })
      expect(value(10)).toMatchObject({
        Number: '1',
        InvoiceNumber: '101',
        ModeOfPaymentAccount: 1930,
        VoucherNumber: 1,
        VoucherYear: 3
      })
      expect(value(15)).toMatchObject({ DocumentNumber: '1', Total: 12438, OrderReference: '0' })
      expect(value(18)).toMatchObject({ Id: 'root' })
      expect(value(22)).toBeDefined()
      expect(field(value(27), 'pagination')).toMatchObject({
        currentPage: 2,
        totalPages: 2,
        totalResources: 2
      })
      expect(value(26)).toMatchObject({ Code: 'BG', AccountNumber: 1930 })
      expect(value(35)).toMatchObject({ Name: 'Example User', SysAdmin: true })

      // Nothing the connector read wrote anything.
      expect(target.ledger.entries().every(entry => entry.status === 200)).toBe(true)
    })
  )

  it.effect('a missing key reaches the connector as fortnox_not_found', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      const results = yield* Effect.all([
        run(fortnoxGetArticleAction, { articleNumber: 'NOPE' }),
        run(fortnoxGetOfferAction, { documentNumber: '404' }),
        run(fortnoxGetUnitAction, { code: 'NOPE' })
      ]).pipe(Effect.provide(connectorLayer(target)))

      for (const { id, result } of results) {
        expect(result, id).toMatchObject({
          _tag: 'Failure',
          error: {
            code: 'fortnox_not_found',
            status: 404,
            underlying: { providerCode: fortnoxEmulatorErrorCodes.resourceNotFound }
          }
        })
      }
    })
  )

  it.effect('the host-only offer preview and inbox file downloads return the bytes', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())
      const layer = connectorLayer(target)

      const preview = yield* downloadFortnoxOfferPreview(
        fortnoxConformanceIntegration,
        { documentNumber: FortnoxDocumentNumber.make('1') },
        budget
      ).pipe(Effect.provide(layer))

      expect(new TextDecoder().decode(preview.bytes.subarray(0, 5))).toBe('%PDF-')
      expect(preview.source).toEqual({ id: '1', generatedPreview: true })

      const file = yield* downloadFortnoxInboxFile(
        fortnoxConformanceIntegration,
        { fileId: '00000000-0000-4000-8000-000000000002' },
        budget
      ).pipe(Effect.provide(layer))

      expect(new TextDecoder().decode(file.bytes)).toBe('Synthetic receipt (example.test).\n')
      expect(file.byteLength).toBe(file.bytes.byteLength)

      const missing = yield* downloadFortnoxInboxFile(
        fortnoxConformanceIntegration,
        { fileId: '00000000-0000-4000-8000-000000000404' },
        budget
      ).pipe(Effect.provide(layer), Effect.flip)

      expect(missing).toMatchObject({ _tag: 'ConnectorFileTransferError', status: 404 })
    })
  )
})

describe('manifest', () => {
  it('lists 34 read-only routes, none a write, none citing a case', () => {
    const reads = fortnoxEmulatorRoutes.slice(10)

    expect(reads).toHaveLength(34)
    expect(reads.filter(route => route.write || route.caseIds.length > 0)).toEqual([])
  })
})
