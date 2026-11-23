import { Chunk, Effect, SchemaIssue, SchemaTransformation } from 'effect'
import type { SchemaAST } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FortnoxGivenNumber,
  FortnoxInvoice,
  FortnoxInvoiceRow,
  FortnoxSupplierInvoice,
  FortnoxSupplierInvoiceRow,
  FortnoxSupplierNumber
} from './schemas.ts'

// Fortnox list rows send invoice-level amounts as numeric strings (e.g. CurrencyRate: "1")
// while single-invoice reads send JSON numbers. Accept either at the wire boundary only;
// the public FortnoxInvoice types stay number | null | undefined.
const NumericStringPattern = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/

const invalidWireValue = (
  kind: string,
  value: unknown,
  options: SchemaAST.ParseOptions
): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(
    new SchemaIssue.InvalidValue(
      { message: `Expected ${kind}, got ${JSON.stringify(value)}` },
      value,
      options
    )
  )

// Trimmed numeric strings decode to numbers; "" means unset (null). Anything else
// non-numeric still fails instead of silently coercing garbage.
const NumericStringToNumber = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.Number),
    SchemaTransformation.transformEffect({
      decode: (
        value: string,
        options: SchemaAST.ParseOptions
      ): Effect.Effect<number | null, SchemaIssue.Issue> => {
        const trimmed = value.trim()

        if (trimmed === '') return Effect.succeed(null)

        if (!NumericStringPattern.test(trimmed))
          return invalidWireValue('a finite number or numeric string', value, options)

        const parsed = Number(trimmed)

        return Number.isFinite(parsed)
          ? Effect.succeed(parsed)
          : invalidWireValue('a finite number or numeric string', value, options)
      },
      encode: (value: number | null): Effect.Effect<string, SchemaIssue.Issue> =>
        Effect.succeed(value === null ? '' : String(value))
    })
  )
)

// A JSON number past the double range parses to Infinity; it fails here, as a decode issue, rather
// than when the public Finite fields re-check it.
const NumberFromNumberOrNumericString = Schema.Union([
  Schema.Finite,
  NumericStringToNumber,
  Schema.Null
])

export const WireNullableNumber = Schema.optional(NumberFromNumberOrNumericString)

// Supplier invoice amounts stay strings publicly ("do not coerce financial values").
// The wire boundary additionally accepts a finite JSON number and records its string form.
const FiniteNumberToString = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (
        value: number,
        options: SchemaAST.ParseOptions
      ): Effect.Effect<string, SchemaIssue.Issue> =>
        Number.isFinite(value)
          ? Effect.succeed(String(value))
          : invalidWireValue('a finite number or string', value, options),
      encode: (
        value: string,
        options: SchemaAST.ParseOptions
      ): Effect.Effect<number, SchemaIssue.Issue> => {
        const parsed = Number(value)

        return Number.isFinite(parsed)
          ? Effect.succeed(parsed)
          : invalidWireValue('a finite number or string', value, options)
      }
    })
  )
)

const StringFromStringOrFiniteNumber = Schema.Union([
  FiniteNumberToString,
  Schema.String,
  Schema.Null
])

export const WireNullableAmountString = Schema.optional(StringFromStringOrFiniteNumber)

// Fortnox docs examples send some identifiers as a JSON string in one response and a JSON integer
// in another. Accept both at the wire; public schemas stay strings.
const IntToString = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value: number) => String(value),
      encode: (value: string) => Number(value)
    })
  )
)

export const StringOrInt = Schema.Union([Schema.String, IntToString])

const EmptyStringToNull = Schema.Literal('').pipe(
  Schema.decodeTo(
    Schema.Null,
    SchemaTransformation.transform({
      decode: (): null => null,
      encode: (): '' => ''
    })
  )
)

const IntegerStringToInt = Schema.String.check(Schema.isPattern(/^[+-]?[0-9]+$/u)).pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transform({
      decode: (value: string) => Number(value),
      encode: (value: number) => String(value)
    })
  )
)

// A required integer Fortnox may send as a JSON integer or an integer string (voucher file
// connections send `VoucherNumber` as a string, which OpenAPI types as a string there and as an
// integer on vouchers). Public type is int.
export const WireInt = Schema.Union([Schema.Int, IntegerStringToInt])

// Integer fields Fortnox sometimes sends as numeric strings ("" meaning unset); public type is
// int | null | undefined.
export const WireNullableInt = Schema.optional(
  Schema.Union([Schema.Int, Schema.Null, EmptyStringToNull, IntegerStringToInt])
)

// Fortnox sends some flags as "true"/"false" strings (its customer invoice `Credit` is one);
// "" means unset. Public type is boolean | null | undefined.
const BooleanStringToBoolean = Schema.Literals(['true', 'false']).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value: 'true' | 'false') => value === 'true',
      encode: (value: boolean): 'true' | 'false' => (value ? 'true' : 'false')
    })
  )
)

export const WireNullableBoolean = Schema.optional(
  Schema.Union([Schema.Boolean, Schema.Null, EmptyStringToNull, BooleanStringToBoolean])
)

// Reference strings (supplier invoice numbers, OCR, cost centers, projects) that Fortnox may send as
// JSON integers.
export const WireNullableReference = Schema.optional(
  Schema.Union([Schema.String, IntToString, Schema.Null])
)

// Provider JSON arrays and public runtime Chunks are distinct decode boundaries.
export const FortnoxInvoiceApi = Schema.Struct({
  ...FortnoxInvoice.fields,
  Total: WireNullableNumber,
  Balance: WireNullableNumber,
  TotalVAT: WireNullableNumber,
  TotalToPay: WireNullableNumber,
  Net: WireNullableNumber,
  Gross: WireNullableNumber,
  CurrencyRate: WireNullableNumber,
  InvoiceRows: Schema.optional(Schema.Array(FortnoxInvoiceRow))
})

export const invoiceFromApi = (value: typeof FortnoxInvoiceApi.Type) => {
  const { InvoiceRows, ...fields } = value

  return FortnoxInvoice.make(
    (() => {
      type InvoiceFromApiFields = typeof fields & {
        InvoiceRows?: FortnoxInvoice['InvoiceRows']
      }

      const out: InvoiceFromApiFields = { ...fields }

      if (InvoiceRows !== undefined) {
        out.InvoiceRows = Chunk.fromIterable(InvoiceRows)
      }

      return out
    })()
  )
}

// Fortnox's OpenAPI types for supplier invoices do not match every live answer: a populated list or
// read failed to decode on a live company while its empty lists decoded. As for payments, every
// scalar accepts each JSON form Fortnox uses for its meaning, and the public FortnoxSupplierInvoice
// types are unchanged.
const FortnoxSupplierInvoiceRowApi = Schema.Struct({
  ...FortnoxSupplierInvoiceRow.fields,
  Account: WireNullableInt,
  ArticleNumber: WireNullableReference,
  CostCenter: WireNullableReference,
  Project: WireNullableReference,
  Debit: WireNullableNumber,
  Credit: WireNullableNumber,
  DebitCurrency: WireNullableNumber,
  CreditCurrency: WireNullableNumber,
  Price: WireNullableNumber,
  Quantity: WireNullableNumber,
  Total: WireNullableNumber
})

export const FortnoxSupplierInvoiceApi = Schema.Struct({
  ...FortnoxSupplierInvoice.fields,
  GivenNumber: StringOrInt.pipe(Schema.decodeTo(FortnoxGivenNumber)),
  SupplierNumber: StringOrInt.pipe(Schema.decodeTo(FortnoxSupplierNumber)),
  InvoiceNumber: WireNullableReference,
  OCR: WireNullableReference,
  CostCenter: WireNullableReference,
  Project: WireNullableReference,
  Booked: WireNullableBoolean,
  Cancelled: WireNullableBoolean,
  Credit: WireNullableBoolean,
  PaymentPending: WireNullableBoolean,
  VoucherNumber: WireNullableInt,
  Total: WireNullableAmountString,
  Balance: WireNullableAmountString,
  CurrencyRate: WireNullableAmountString,
  SupplierInvoiceRows: Schema.optional(Schema.Array(FortnoxSupplierInvoiceRowApi))
})

export const supplierInvoiceFromApi = (value: typeof FortnoxSupplierInvoiceApi.Type) => {
  const { SupplierInvoiceRows, ...fields } = value

  return FortnoxSupplierInvoice.make(
    (() => {
      type SupplierInvoiceFromApiFields = typeof fields & {
        SupplierInvoiceRows?: FortnoxSupplierInvoice['SupplierInvoiceRows']
      }

      const out: SupplierInvoiceFromApiFields = { ...fields }

      if (SupplierInvoiceRows !== undefined) {
        out.SupplierInvoiceRows = Chunk.fromIterable(
          SupplierInvoiceRows.map(row => FortnoxSupplierInvoiceRow.make(row))
        )
      }

      return out
    })()
  )
}
