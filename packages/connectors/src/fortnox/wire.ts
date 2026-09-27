import { Chunk, Effect, SchemaIssue, SchemaTransformation } from 'effect'
import type { SchemaAST } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FortnoxInvoice,
  FortnoxInvoiceRow,
  FortnoxSupplierInvoice,
  FortnoxSupplierInvoiceRow
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

const NumberFromNumberOrNumericString = Schema.Union([
  Schema.Number,
  NumericStringToNumber,
  Schema.Null
])

const WireNullableNumber = Schema.optional(NumberFromNumberOrNumericString)

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

const WireNullableAmountString = Schema.optional(StringFromStringOrFiniteNumber)

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

export const FortnoxSupplierInvoiceApi = Schema.Struct({
  ...FortnoxSupplierInvoice.fields,
  Total: WireNullableAmountString,
  Balance: WireNullableAmountString,
  CurrencyRate: WireNullableAmountString,
  SupplierInvoiceRows: Schema.optional(Schema.Array(FortnoxSupplierInvoiceRow))
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
        out.SupplierInvoiceRows = Chunk.fromIterable(SupplierInvoiceRows)
      }

      return out
    })()
  )
}
