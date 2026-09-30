/**
 * Fortnox conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * Fortnox API wire. `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages verified
 * recordings from a Fortnox developer test company in a gitignored directory; a person scrubs them
 * and promotes them here, updating the tests together with them (fixture ids, `evidence`, and
 * `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { fortnoxCustomerEmptyStringFixture } from './customer-empty-string.ts'
import { fortnoxInvoiceListPopulatedFixture } from './invoice-list-populated.ts'
import { fortnoxInvoicePaymentFiltersFixture } from './invoice-payment-filters.ts'
import { fortnoxInvoicePreviewPdfFixture } from './invoice-preview-pdf.ts'
import { fortnoxInvoiceRowDiscountFixture } from './invoice-row-discount.ts'
import { fortnoxInvoiceSendEmailFixture } from './invoice-send-email.ts'
import { fortnoxWriteRejectionFixture } from './write-rejection.ts'

export {
  FortnoxConformanceActionFailed,
  FortnoxConformanceConfig,
  FortnoxConformanceRestoreFailed,
  FortnoxConformanceSeeds,
  fortnoxConformanceCases,
  fortnoxConformanceCommentsMarker,
  fortnoxConformanceCredentialRef,
  fortnoxConformanceIntegration,
  fortnoxCustomerEmptyStringCase,
  fortnoxInvoiceListPopulatedCase,
  fortnoxInvoicePaymentFiltersCase,
  fortnoxInvoicePreviewPdfCase,
  fortnoxInvoiceRowDiscountCase,
  fortnoxInvoiceSendEmailCase,
  fortnoxWriteRejectionCase,
  type FortnoxConformanceCase,
  type FortnoxConformanceError,
  type FortnoxConformanceRequirements,
  type FortnoxConformanceSeedKey
} from './cases.ts'

export { fortnoxConformanceFixtureSeeds } from './seeds.ts'

export {
  fortnoxCustomerEmptyStringFixture,
  fortnoxInvoiceListPopulatedFixture,
  fortnoxInvoicePaymentFiltersFixture,
  fortnoxInvoicePreviewPdfFixture,
  fortnoxInvoiceRowDiscountFixture,
  fortnoxInvoiceSendEmailFixture,
  fortnoxWriteRejectionFixture
}

/** Every Fortnox wire fixture, in case order, for replaying the whole suite at once. */
export const fortnoxConformanceFixtures: ReadonlyArray<WireFixture> = [
  fortnoxInvoiceListPopulatedFixture,
  fortnoxInvoicePreviewPdfFixture,
  fortnoxInvoicePaymentFiltersFixture,
  fortnoxInvoiceRowDiscountFixture,
  fortnoxCustomerEmptyStringFixture,
  fortnoxWriteRejectionFixture,
  fortnoxInvoiceSendEmailFixture
]
