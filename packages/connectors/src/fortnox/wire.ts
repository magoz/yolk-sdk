import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FortnoxInvoice,
  FortnoxInvoiceRow,
  FortnoxSupplierInvoice,
  FortnoxSupplierInvoiceRow
} from './schemas.ts'

// Provider JSON arrays and public runtime Chunks are distinct decode boundaries.
export const FortnoxInvoiceApi = Schema.Struct({
  ...FortnoxInvoice.fields,
  InvoiceRows: Schema.optional(Schema.Array(FortnoxInvoiceRow))
})

export const invoiceFromApi = (value: typeof FortnoxInvoiceApi.Type) => {
  const { InvoiceRows, ...fields } = value

  return FortnoxInvoice.make({
    ...fields,
    ...(InvoiceRows === undefined ? {} : { InvoiceRows: Chunk.fromIterable(InvoiceRows) })
  })
}

export const FortnoxSupplierInvoiceApi = Schema.Struct({
  ...FortnoxSupplierInvoice.fields,
  SupplierInvoiceRows: Schema.optional(Schema.Array(FortnoxSupplierInvoiceRow))
})

export const supplierInvoiceFromApi = (value: typeof FortnoxSupplierInvoiceApi.Type) => {
  const { SupplierInvoiceRows, ...fields } = value

  return FortnoxSupplierInvoice.make({
    ...fields,
    ...(SupplierInvoiceRows === undefined
      ? {}
      : { SupplierInvoiceRows: Chunk.fromIterable(SupplierInvoiceRows) })
  })
}
