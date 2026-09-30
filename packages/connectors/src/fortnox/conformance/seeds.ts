import { FortnoxCustomerNumber, FortnoxDocumentNumber } from '../schemas.ts'
import type { FortnoxConformanceSeeds } from './cases.ts'

/**
 * Seed identities the committed Fortnox fixtures were recorded with. Replaying the fixtures needs
 * these exact seeds in `FortnoxConformanceConfig`. `pnpm conformance:fortnox --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const fortnoxConformanceFixtureSeeds: FortnoxConformanceSeeds = {
  discountInvoiceDocumentNumber: FortnoxDocumentNumber.make('103'),
  previewInvoiceDocumentNumber: FortnoxDocumentNumber.make('102'),
  customerNumber: FortnoxCustomerNumber.make('1001'),
  missingCustomerNumber: FortnoxCustomerNumber.make('99999'),
  emailInvoiceDocumentNumber: FortnoxDocumentNumber.make('104'),
  emailRecipient: 'billing@example.test'
}
