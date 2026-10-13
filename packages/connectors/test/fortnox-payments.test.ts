import { Chunk, Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { resolveTools, toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  defineConnector,
  makeCredentialBinding,
  makeIntegration,
  OAuthCredential
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import { makeConnectorToolModule } from '@yolk-sdk/connectors/agent'
import { FortnoxDocumentNumber, FortnoxGivenNumber } from '@yolk-sdk/connectors/fortnox'
import {
  FortnoxCreateInvoicePaymentInput,
  FortnoxInvoicePayment,
  FortnoxInvoicePaymentNumber,
  FortnoxListInvoicePaymentsOutput,
  FortnoxListSupplierInvoicePaymentsOutput,
  FortnoxSupplierInvoicePayment,
  FortnoxUpdateSupplierInvoicePaymentInput,
  FortnoxSupplierInvoicePaymentNumber,
  fortnoxBookkeepInvoicePaymentAction,
  fortnoxBookkeepSupplierInvoicePaymentAction,
  fortnoxCreateInvoicePaymentAction,
  fortnoxCreateSupplierInvoicePaymentAction,
  fortnoxDeleteInvoicePaymentAction,
  fortnoxDeleteSupplierInvoicePaymentAction,
  fortnoxGetInvoicePaymentAction,
  fortnoxGetSupplierInvoicePaymentAction,
  fortnoxListInvoicePaymentsAction,
  fortnoxListSupplierInvoicePaymentsAction,
  fortnoxPaymentActions,
  fortnoxUpdateInvoicePaymentAction,
  fortnoxUpdateSupplierInvoicePaymentAction
} from '../src/fortnox/payments.ts'

const integration = makeIntegration({
  connectorId: 'fortnox',
  credentialBindings: [
    makeCredentialBinding({ slotId: 'fortnox.oauth', credentialRef: 'host-fortnox-ref' })
  ]
})

const oauth = OAuthCredential.make({
  provider: 'fortnox',
  accessToken: 'test-access-token',
  expiresAt: 4_000_000_000_000
})

const isJson = Schema.is(Schema.Json)

const response = (
  body: Schema.Json,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
) => {
  if (!isJson(body)) throw new TypeError('JSON fixture requires a finite JSON value')

  return ConnectorHttpResponse.make({ status, headers, body: JSON.stringify(body) })
}

const empty = (status: number) => ConnectorHttpResponse.make({ status, headers: {}, body: '' })

const meta = (currentPage = 1, totalPages = 1, totalResources = 1) => ({
  '@CurrentPage': currentPage,
  '@TotalPages': totalPages,
  '@TotalResources': totalResources
})

const makeHarness = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
  const requests: Array<ConnectorHttpRequest> = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: request => {
          expect(request.binding.credentialRef).toBe('host-fortnox-ref')
          expect(request.slot.id).toBe('fortnox.oauth')
          scopes.push(request.slot.requiredScopes)

          return Effect.succeed(oauth)
        }
      })
    ),
    Layer.succeed(
      ConnectorHttpClient,
      ConnectorHttpClient.of({
        request: request => {
          requests.push(request)
          const next = responses.at(requests.length - 1)

          return next === undefined
            ? Effect.die(new Error('Unexpected Fortnox HTTP request'))
            : Effect.succeed(next)
        }
      })
    )
  )

  return { layer, requests, scopes }
}

const readHeaders = { authorization: 'Bearer test-access-token', accept: 'application/json' }

const writeHeaders = { ...readHeaders, 'content-type': 'application/json' }

const base = 'https://api.fortnox.se/3'

const requestBody = (request: ConnectorHttpRequest | undefined) =>
  request?.body === undefined ? undefined : JSON.parse(request.body)

// Synthetic single-record shapes following the Fortnox docs examples, including their mixed wire
// types: Number/InvoiceNumber as string or integer, InvoiceTotal and voucher fields as strings.
const invoicePaymentWire = {
  '@url': `${base}/invoicepayments/7`,
  Number: '7',
  InvoiceNumber: 12,
  Amount: 99.5,
  AmountCurrency: 99.5,
  Booked: false,
  Currency: 'SEK',
  CurrencyRate: 1,
  CurrencyUnit: 1,
  ExternalInvoiceReference1: '',
  InvoiceCustomerName: 'Example AB',
  InvoiceCustomerNumber: '1',
  InvoiceDueDate: '2026-01-31',
  InvoiceOCR: '1234',
  InvoiceTotal: '1195',
  ModeOfPayment: 'BG',
  ModeOfPaymentAccount: 1930,
  PaymentDate: '2026-01-20',
  Source: 'manual',
  VoucherNumber: null,
  VoucherSeries: null,
  VoucherYear: null,
  WriteOffs: [{ Amount: 0.5, AccountNumber: 3740, Currency: 'SEK', Description: 'Rounding' }]
}

const supplierInvoicePaymentWire = {
  '@url': `${base}/supplierinvoicepayments/8`,
  Number: 8,
  InvoiceNumber: '4',
  Amount: 250,
  AmountCurrency: 250,
  Booked: false,
  Currency: 'SEK',
  CurrencyRate: 1,
  CurrencyUnit: 1,
  Information: null,
  InvoiceDueDate: '2026-02-28',
  InvoiceOCR: '',
  InvoiceSupplierName: 'Supplier AB',
  InvoiceSupplierNumber: '3',
  InvoiceTotal: '10000',
  ModeOfPayment: '',
  PaymentDate: '2026-02-01',
  Source: 'manual',
  VoucherNumber: null,
  VoucherSeries: null,
  VoucherYear: null,
  WriteOffs: []
}

const run = (
  action: (typeof fortnoxPaymentActions)[number],
  input: unknown,
  layer: ReturnType<typeof makeHarness>['layer']
) => action.execute({ integration, input }).pipe(Effect.provide(layer))

const successValue = (result: unknown) => {
  if (!Predicate.isTagged(result, 'Success') || !Predicate.hasProperty(result, 'value'))
    throw new Error('Expected an ActionResult success')

  return result.value
}

describe('Fortnox payment actions', () => {
  it('exports twelve payment actions in stable order with access metadata', () => {
    expect(fortnoxPaymentActions.map(action => [action.id, action.access])).toEqual([
      ['fortnox.list_invoice_payments', 'read'],
      ['fortnox.get_invoice_payment', 'read'],
      ['fortnox.create_invoice_payment', 'write'],
      ['fortnox.update_invoice_payment', 'write'],
      ['fortnox.delete_invoice_payment', 'destructive'],
      ['fortnox.bookkeep_invoice_payment', 'destructive'],
      ['fortnox.list_supplier_invoice_payments', 'read'],
      ['fortnox.get_supplier_invoice_payment', 'read'],
      ['fortnox.create_supplier_invoice_payment', 'write'],
      ['fortnox.update_supplier_invoice_payment', 'write'],
      ['fortnox.delete_supplier_invoice_payment', 'destructive'],
      ['fortnox.bookkeep_supplier_invoice_payment', 'destructive']
    ])

    for (const action of fortnoxPaymentActions) {
      expect(action.description?.length ?? 0).toBeGreaterThan(0)
    }

    for (const action of fortnoxPaymentActions.filter(item => item.access === 'destructive')) {
      expect(action.description).toContain('cannot be undone')
    }
  })

  it.effect('adapts every payment action to an agent tool with JSON output schemas', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])
      const connector = defineConnector({ id: 'fortnox', actions: fortnoxPaymentActions })

      const toolSet = yield* resolveTools(
        [makeConnectorToolModule(connector, { integration, layer: harness.layer })],
        {}
      )

      expect(toolSet.tools).toHaveLength(12)

      for (const action of fortnoxPaymentActions) {
        expect(() => toolJsonSchemaFromSchema(action.outputSchema)).not.toThrow()
        expect(toolSet.metadata.find(item => item.name === action.id)?.access).toBe(action.access)
      }

      for (const name of [
        'fortnox.create_invoice_payment',
        'fortnox.update_invoice_payment',
        'fortnox.create_supplier_invoice_payment',
        'fortnox.update_supplier_invoice_payment'
      ]) {
        expect(toolSet.tools.find(tool => tool.name === name)?.parameters).toMatchObject({
          type: 'object',
          additionalProperties: false
        })
      }

      expect(harness.requests).toHaveLength(0)
    })
  )

  it.effect('get_invoice_payment reads by payment Number and normalizes mixed wire types', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ InvoicePayment: invoicePaymentWire })])

      const result = yield* run(
        fortnoxGetInvoicePaymentAction,
        { paymentNumber: '7' },
        harness.layer
      )

      expect(harness.requests).toHaveLength(1)
      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: `${base}/invoicepayments/7`,
        headers: readHeaders
      })
      expect(harness.requests[0]?.body).toBeUndefined()
      expect(harness.requests[0]?.headers).not.toHaveProperty('content-type')
      expect(harness.scopes).toEqual([['payment']])

      const payment = yield* Schema.decodeUnknownEffect(FortnoxInvoicePayment)(successValue(result))

      expect(payment).toMatchObject({
        Number: '7',
        InvoiceNumber: '12',
        Amount: 99.5,
        InvoiceTotal: 1195,
        ModeOfPaymentAccount: 1930,
        Booked: false,
        VoucherNumber: null,
        InvoiceCustomerName: 'Example AB'
      })
      expect(payment).not.toHaveProperty('ExternalInvoiceReference1')
      expect(payment).not.toHaveProperty('@url')
      expect(Chunk.toReadonlyArray(payment.WriteOffs ?? Chunk.empty())).toEqual([
        { Amount: 0.5, AccountNumber: 3740, Currency: 'SEK', Description: 'Rounding' }
      ])
    })
  )

  it.effect('decodes integer fields Fortnox sends as numeric or empty strings', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          InvoicePayment: {
            ...invoicePaymentWire,
            Number: 7,
            InvoiceNumber: '12',
            ModeOfPaymentAccount: '1930',
            VoucherNumber: '41',
            VoucherSeries: 'C',
            VoucherYear: '2',
            Booked: true,
            WriteOffs: [{ Amount: '0.50', AccountNumber: '' }]
          }
        })
      ])

      const result = yield* run(
        fortnoxGetInvoicePaymentAction,
        { paymentNumber: '7' },
        harness.layer
      )

      expect(result).toMatchObject({
        value: {
          Number: '7',
          InvoiceNumber: '12',
          ModeOfPaymentAccount: 1930,
          VoucherNumber: 41,
          VoucherYear: 2,
          Booked: true
        }
      })

      const payment = yield* Schema.decodeUnknownEffect(FortnoxInvoicePayment)(successValue(result))

      expect(Chunk.toReadonlyArray(payment.WriteOffs ?? Chunk.empty())).toEqual([
        { Amount: 0.5, AccountNumber: null }
      ])
    })
  )

  for (const wire of [
    { Amount: 'abc' },
    { VoucherNumber: '1.5' },
    { Number: 'not-a-number' },
    { InvoiceNumber: null }
  ]) {
    it.effect(`rejects malformed payment wire values ${JSON.stringify(wire)}`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response({ InvoicePayment: { ...invoicePaymentWire, ...wire } })
        ])

        const result = yield* run(
          fortnoxGetInvoicePaymentAction,
          { paymentNumber: '7' },
          harness.layer
        ).pipe(Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      })
    )
  }

  it.effect('get_supplier_invoice_payment keeps InvoiceNumber as the GivenNumber', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ SupplierInvoicePayment: supplierInvoicePaymentWire })
      ])

      const result = yield* run(
        fortnoxGetSupplierInvoicePaymentAction,
        { paymentNumber: '8' },
        harness.layer
      )

      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: `${base}/supplierinvoicepayments/8`,
        headers: readHeaders
      })
      expect(harness.scopes).toEqual([['payment']])

      const payment = yield* Schema.decodeUnknownEffect(FortnoxSupplierInvoicePayment)(
        successValue(result)
      )

      expect(payment).toMatchObject({
        Number: '8',
        InvoiceNumber: '4',
        Amount: 250,
        InvoiceTotal: 10000,
        Information: null,
        InvoiceSupplierName: 'Supplier AB'
      })
      expect(Chunk.size(payment.WriteOffs ?? Chunk.empty())).toBe(0)
    })
  )

  it.effect('lists invoice payments with pagination and invoicenumber search', () =>
    Effect.gen(function* () {
      const row = {
        '@url': `${base}/invoicepayments/3`,
        Amount: 1337,
        Booked: true,
        Currency: 'SEK',
        CurrencyRate: 1,
        CurrencyUnit: 1,
        InvoiceNumber: 1,
        Number: '3',
        PaymentDate: '2026-01-08',
        ModeOfPaymentAccount: '1930',
        Source: 'direct',
        WriteOffExist: false
      }

      const harness = makeHarness([
        response({ InvoicePayments: [row], MetaInformation: meta(2, 3, 5) })
      ])

      const result = yield* run(
        fortnoxListInvoicePaymentsAction,
        {
          page: 2,
          limit: 2,
          lastModified: '2026-01-01 12:00',
          search: { field: 'invoicenumber', value: '1' }
        },
        harness.layer
      )

      const url = new URL(harness.requests[0]?.url ?? '')
      expect(`${url.origin}${url.pathname}`).toBe(`${base}/invoicepayments`)
      expect(Object.fromEntries(url.searchParams)).toEqual({
        page: '2',
        limit: '2',
        lastmodified: '2026-01-01 12:00',
        invoicenumber: '1'
      })
      expect(harness.requests[0]).toMatchObject({ method: 'GET', headers: readHeaders })
      expect(harness.scopes).toEqual([['payment']])

      const output = yield* Schema.decodeUnknownEffect(FortnoxListInvoicePaymentsOutput)(
        successValue(result)
      )

      expect(output.pagination).toEqual({
        currentPage: 2,
        totalPages: 3,
        totalResources: 5,
        nextPage: 3
      })
      expect(Chunk.toReadonlyArray(output.invoicePayments)).toMatchObject([
        { Number: '3', InvoiceNumber: '1', Amount: 1337, ModeOfPaymentAccount: 1930 }
      ])
    })
  )

  it.effect('lists supplier invoice payments by GivenNumber with a final page', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ SupplierInvoicePayments: [], MetaInformation: meta(1, 1, 0) })
      ])

      const result = yield* run(
        fortnoxListSupplierInvoicePaymentsAction,
        { search: { field: 'invoicenumber', value: '4' } },
        harness.layer
      )

      expect(harness.requests[0]?.url).toBe(`${base}/supplierinvoicepayments?invoicenumber=4`)

      const output = yield* Schema.decodeUnknownEffect(FortnoxListSupplierInvoicePaymentsOutput)(
        successValue(result)
      )

      expect(output.pagination).toEqual({ currentPage: 1, totalPages: 1, totalResources: 0 })
      expect(Chunk.size(output.supplierInvoicePayments)).toBe(0)
    })
  )

  const malformedPages: ReadonlyArray<Schema.Json> = [
    { InvoicePayments: [] },
    { InvoicePayments: [{ Number: '3' }], MetaInformation: meta() }
  ]

  for (const body of malformedPages) {
    it.effect('rejects list pages without MetaInformation or required identifiers', () =>
      Effect.gen(function* () {
        const harness = makeHarness([response(body)])

        const result = yield* run(fortnoxListInvoicePaymentsAction, {}, harness.layer).pipe(
          Effect.result
        )

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      })
    )
  }

  it.effect('creates an invoice payment with only the provided writable fields', () =>
    Effect.gen(function* () {
      const harness = makeHarness([response({ InvoicePayment: invoicePaymentWire }, 201)])

      const input = {
        InvoiceNumber: '12',
        Amount: 99.5,
        AmountCurrency: 9.95,
        CurrencyRate: 10,
        PaymentDate: '2026-01-20',
        ModeOfPayment: 'BG',
        ModeOfPaymentAccount: 1930,
        WriteOffs: [
          {
            Amount: 0.5,
            AccountNumber: 3740,
            CostCenter: 'CC1',
            Project: 'P1',
            TransactionInformation: 'Rounding'
          }
        ]
      }

      const result = yield* run(fortnoxCreateInvoicePaymentAction, input, harness.layer)

      expect(result).toMatchObject({ value: { Number: '7', InvoiceNumber: '12' } })
      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: `${base}/invoicepayments`,
        headers: writeHeaders
      })
      expect(requestBody(harness.requests[0])).toEqual({ InvoicePayment: input })
      expect(harness.scopes).toEqual([['payment']])
    })
  )

  it.effect('creates a supplier invoice payment against the GivenNumber', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ SupplierInvoicePayment: supplierInvoicePaymentWire }, 201)
      ])

      const input = {
        InvoiceNumber: '4',
        Amount: 250,
        Information: 'Example payment',
        InvoiceOCR: '1234567897',
        WriteOffs: [{ Amount: 1, AccountNumber: 6570 }]
      }

      const result = yield* run(fortnoxCreateSupplierInvoicePaymentAction, input, harness.layer)

      expect(result).toMatchObject({ value: { Number: '8', InvoiceNumber: '4' } })
      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: `${base}/supplierinvoicepayments`,
        headers: writeHeaders
      })
      expect(requestBody(harness.requests[0])).toEqual({ SupplierInvoicePayment: input })
    })
  )

  it.effect('updates payments by Number without sending Number in the body', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ InvoicePayment: invoicePaymentWire }),
        response({ SupplierInvoicePayment: supplierInvoicePaymentWire })
      ])

      yield* run(
        fortnoxUpdateInvoicePaymentAction,
        { Number: '7', Amount: 100, PaymentDate: '2026-01-21' },
        harness.layer
      )

      yield* run(
        fortnoxUpdateSupplierInvoicePaymentAction,
        { Number: '8', ModeOfPayment: 'BG' },
        harness.layer
      )

      expect(harness.requests[0]).toMatchObject({
        method: 'PUT',
        url: `${base}/invoicepayments/7`,
        headers: writeHeaders
      })
      expect(requestBody(harness.requests[0])).toEqual({
        InvoicePayment: { Amount: 100, PaymentDate: '2026-01-21' }
      })
      expect(harness.requests[1]).toMatchObject({
        method: 'PUT',
        url: `${base}/supplierinvoicepayments/8`,
        headers: writeHeaders
      })
      expect(requestBody(harness.requests[1])).toEqual({
        SupplierInvoicePayment: { ModeOfPayment: 'BG' }
      })
      expect(harness.scopes).toEqual([['payment'], ['payment']])
    })
  )

  it.effect('sends typed writes built from the exported input classes', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ InvoicePayment: invoicePaymentWire }),
        response({ SupplierInvoicePayment: supplierInvoicePaymentWire })
      ])

      yield* fortnoxCreateInvoicePaymentAction
        .executeTyped({
          integration,
          input: FortnoxCreateInvoicePaymentInput.make({
            InvoiceNumber: FortnoxDocumentNumber.make('12'),
            Amount: 10
          })
        })
        .pipe(Effect.provide(harness.layer))

      yield* fortnoxUpdateSupplierInvoicePaymentAction
        .executeTyped({
          integration,
          input: FortnoxUpdateSupplierInvoicePaymentInput.make({
            Number: FortnoxSupplierInvoicePaymentNumber.make('8'),
            Information: 'Updated'
          })
        })
        .pipe(Effect.provide(harness.layer))

      expect(requestBody(harness.requests[0])).toEqual({
        InvoicePayment: { InvoiceNumber: '12', Amount: 10 }
      })
      expect(harness.requests[1]?.url).toBe(`${base}/supplierinvoicepayments/8`)
      expect(requestBody(harness.requests[1])).toEqual({
        SupplierInvoicePayment: { Information: 'Updated' }
      })
    })
  )

  it.effect('deletes payments on a 2xx without decoding the empty body', () =>
    Effect.gen(function* () {
      const harness = makeHarness([empty(204), empty(200)])

      const invoice = yield* run(
        fortnoxDeleteInvoicePaymentAction,
        { paymentNumber: '7' },
        harness.layer
      )

      const supplier = yield* run(
        fortnoxDeleteSupplierInvoicePaymentAction,
        { paymentNumber: '8' },
        harness.layer
      )

      expect(invoice).toMatchObject({ value: { paymentNumber: '7', deleted: true } })
      expect(supplier).toMatchObject({ value: { paymentNumber: '8', deleted: true } })
      expect(harness.requests[0]).toMatchObject({
        method: 'DELETE',
        url: `${base}/invoicepayments/7`,
        headers: readHeaders
      })
      expect(harness.requests[1]).toMatchObject({
        method: 'DELETE',
        url: `${base}/supplierinvoicepayments/8`,
        headers: readHeaders
      })
      expect(harness.requests.map(request => request.body)).toEqual([undefined, undefined])
      expect(harness.scopes).toEqual([['payment'], ['payment']])
    })
  )

  it.effect('bookkeeps payments with a body-less PUT and returns the booked payment', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          InvoicePayment: {
            ...invoicePaymentWire,
            Booked: true,
            VoucherNumber: 4,
            VoucherSeries: 'C',
            VoucherYear: 1
          }
        }),
        response({ SupplierInvoicePayment: { ...supplierInvoicePaymentWire, Booked: true } })
      ])

      const invoice = yield* run(
        fortnoxBookkeepInvoicePaymentAction,
        { paymentNumber: '7' },
        harness.layer
      )

      const supplier = yield* run(
        fortnoxBookkeepSupplierInvoicePaymentAction,
        { paymentNumber: '8' },
        harness.layer
      )

      expect(invoice).toMatchObject({
        value: { Number: '7', Booked: true, VoucherNumber: 4, VoucherSeries: 'C' }
      })
      expect(supplier).toMatchObject({ value: { Number: '8', Booked: true } })
      expect(harness.requests[0]).toMatchObject({
        method: 'PUT',
        url: `${base}/invoicepayments/7/bookkeep`,
        headers: readHeaders
      })
      expect(harness.requests[1]).toMatchObject({
        method: 'PUT',
        url: `${base}/supplierinvoicepayments/8/bookkeep`,
        headers: readHeaders
      })

      for (const request of harness.requests) {
        expect(request.body).toBeUndefined()
        expect(request.headers).not.toHaveProperty('content-type')
      }

      expect(harness.scopes).toEqual([['payment'], ['payment']])
    })
  )

  const invalidInputs: ReadonlyArray<{
    readonly name: string
    readonly action: (typeof fortnoxPaymentActions)[number]
    readonly input: unknown
  }> = [
    {
      name: 'dot payment number',
      action: fortnoxGetInvoicePaymentAction,
      input: { paymentNumber: '..' }
    },
    {
      name: 'path payment number',
      action: fortnoxDeleteInvoicePaymentAction,
      input: { paymentNumber: '7/bookkeep' }
    },
    {
      name: 'non-numeric payment number',
      action: fortnoxBookkeepSupplierInvoicePaymentAction,
      input: { paymentNumber: 'abc' }
    },
    {
      name: 'empty payment number',
      action: fortnoxGetSupplierInvoicePaymentAction,
      input: { paymentNumber: '' }
    },
    {
      name: 'numeric JSON payment number',
      action: fortnoxGetInvoicePaymentAction,
      input: { paymentNumber: 7 }
    },
    {
      name: 'unknown list search field',
      action: fortnoxListInvoicePaymentsAction,
      input: { search: { field: 'ocr', value: '1' } }
    },
    {
      name: 'supplier search by supplier InvoiceNumber',
      action: fortnoxListSupplierInvoicePaymentsAction,
      input: { search: { field: 'invoicenumber', value: 'INV-2026' } }
    },
    {
      name: 'missing Amount',
      action: fortnoxCreateInvoicePaymentAction,
      input: { InvoiceNumber: '12' }
    },
    {
      name: 'null Amount',
      action: fortnoxCreateInvoicePaymentAction,
      input: { InvoiceNumber: '12', Amount: null }
    },
    {
      name: 'missing InvoiceNumber',
      action: fortnoxCreateSupplierInvoicePaymentAction,
      input: { Amount: 1 }
    },
    {
      name: 'supplier InvoiceNumber instead of GivenNumber',
      action: fortnoxCreateSupplierInvoicePaymentAction,
      input: { InvoiceNumber: 'INV-2026', Amount: 1 }
    },
    {
      name: 'read-only Booked',
      action: fortnoxCreateInvoicePaymentAction,
      input: { InvoiceNumber: '12', Amount: 1, Booked: true }
    },
    {
      name: 'read-only VoucherNumber',
      action: fortnoxUpdateInvoicePaymentAction,
      input: { Number: '7', VoucherNumber: 1 }
    },
    {
      name: 'InvoiceNumber on update',
      action: fortnoxUpdateSupplierInvoicePaymentAction,
      input: { Number: '8', InvoiceNumber: '4' }
    },
    {
      name: 'ModeOfPaymentAccount on supplier payment',
      action: fortnoxCreateSupplierInvoicePaymentAction,
      input: { InvoiceNumber: '4', Amount: 1, ModeOfPaymentAccount: 1930 }
    },
    {
      name: 'read-only write-off Currency',
      action: fortnoxCreateInvoicePaymentAction,
      input: { InvoiceNumber: '12', Amount: 1, WriteOffs: [{ Amount: 1, Currency: 'SEK' }] }
    },
    {
      name: 'three-digit write-off account',
      action: fortnoxCreateSupplierInvoicePaymentAction,
      input: { InvoiceNumber: '4', Amount: 1, WriteOffs: [{ AccountNumber: 999 }] }
    },
    {
      name: 'bad PaymentDate',
      action: fortnoxUpdateInvoicePaymentAction,
      input: { Number: '7', PaymentDate: '20/01/2026' }
    },
    {
      name: 'null optional field',
      action: fortnoxUpdateSupplierInvoicePaymentAction,
      input: { Number: '8', Information: null }
    },
    {
      name: 'non-finite Amount',
      action: fortnoxCreateInvoicePaymentAction,
      input: { InvoiceNumber: '12', Amount: 'Infinity' }
    }
  ]

  for (const item of invalidInputs) {
    it.effect(`rejects ${item.name} before credentials or HTTP`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const result = yield* item.action
          .execute({ integration, input: item.input })
          .pipe(Effect.provide(harness.layer), Effect.result)

        expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
        expect(harness.requests).toHaveLength(0)
        expect(harness.scopes).toHaveLength(0)
      })
    )
  }

  it.effect('rejects unknown keys on typed writes built from Class instances', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const input = Object.assign(
        FortnoxCreateInvoicePaymentInput.make({
          InvoiceNumber: FortnoxDocumentNumber.make('12'),
          Amount: 1
        }),
        { Booked: true }
      )

      const result = yield* fortnoxCreateInvoicePaymentAction
        .executeTyped({ integration, input })
        .pipe(Effect.provide(harness.layer), Effect.result)

      expect(result).toMatchObject({ failure: { cause: 'validation_failed' } })
      expect(harness.requests).toHaveLength(0)
    })
  )

  it.effect('URL-encodes payment numbers and keeps branded ids distinct from GivenNumber', () =>
    Effect.gen(function* () {
      expect(FortnoxInvoicePaymentNumber.make('7')).toBe('7')
      expect(FortnoxGivenNumber.make('4')).toBe('4')

      const harness = makeHarness([response({ InvoicePayment: invoicePaymentWire })])

      yield* run(fortnoxGetInvoicePaymentAction, { paymentNumber: '0007' }, harness.layer)

      expect(harness.requests[0]?.url).toBe(`${base}/invoicepayments/0007`)
    })
  )

  for (const [status, code] of [
    [400, 'fortnox_request_failed'],
    [404, 'fortnox_not_found'],
    [429, 'fortnox_rate_limited']
  ] as const) {
    it.effect(`returns HTTP ${status} from payment writes as a provider failure`, () =>
      Effect.gen(function* () {
        const harness = makeHarness([
          response(
            { ErrorInformation: { error: 1, message: 'Provider detail', code: 2000588 } },
            status
          ),
          response({ ErrorInformation: { Code: 2000588, Message: 'Provider detail' } }, status)
        ])

        const bookkeep = yield* run(
          fortnoxBookkeepInvoicePaymentAction,
          { paymentNumber: '7' },
          harness.layer
        )

        const deleted = yield* run(
          fortnoxDeleteSupplierInvoicePaymentAction,
          { paymentNumber: '8' },
          harness.layer
        )

        const failure = {
          _tag: 'Failure',
          error: { code, status, message: 'Provider detail', underlying: { providerCode: 2000588 } }
        }

        expect(bookkeep).toMatchObject(failure)
        expect(deleted).toMatchObject(failure)
        expect(harness.requests).toHaveLength(2)
      })
    )
  }
})
