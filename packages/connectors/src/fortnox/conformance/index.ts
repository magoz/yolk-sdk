/**
 * Fortnox conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * Fortnox API wire (the read case fixtures from the Fortnox API reference,
 * https://api.fortnox.se/apidocs, and its archived examples).
 * `pnpm conformance:fortnox --live --owner-approved --account <label> --record` stages verified
 * recordings from a Fortnox developer test company in a gitignored directory; a person scrubs them
 * and promotes them here, updating the tests together with them (fixture ids, `evidence`, and
 * `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { fortnoxArticleListRowNumbersFixture } from './article-list-row-numbers.ts'
import { fortnoxCompanyInformationFixture } from './company-information.ts'
import { fortnoxCostCenterListMatchesGetFixture } from './cost-center-list-get.ts'
import { fortnoxCustomerEmptyStringFixture } from './customer-empty-string.ts'
import { fortnoxCustomerListMatchesGetFixture } from './customer-list-get.ts'
import { fortnoxInboxFolderFileBytesFixture } from './inbox-folder-file.ts'
import { fortnoxInvoiceListPopulatedFixture } from './invoice-list-populated.ts'
import { fortnoxInvoicePaymentFiltersFixture } from './invoice-payment-filters.ts'
import { fortnoxInvoicePaymentReadFixture } from './invoice-payment-read.ts'
import { fortnoxInvoicePreviewPdfFixture } from './invoice-preview-pdf.ts'
import { fortnoxInvoiceRowDiscountFixture } from './invoice-row-discount.ts'
import { fortnoxInvoiceSendEmailFixture } from './invoice-send-email.ts'
import { fortnoxOfferRowsAndPreviewFixture } from './offer-rows-preview.ts'
import { fortnoxPredefinedAccountsAndLabelsFixture } from './predefined-accounts-labels.ts'
import { fortnoxPriceTierMatchesSublistFixture } from './price-tier-sublist.ts'
import { fortnoxPrintTemplatesUnpaginatedFixture } from './print-templates.ts'
import { fortnoxProfileMeFixture } from './profile-me.ts'
import { fortnoxSettingsCompanyAndLockedPeriodFixture } from './settings-company-locked-period.ts'
import { fortnoxSettingsRegistersFixture } from './settings-registers.ts'
import { fortnoxSupplierInvoicePaymentReadFixture } from './supplier-invoice-payment-read.ts'
import { fortnoxWriteRejectionFixture } from './write-rejection.ts'

export {
  FortnoxConformanceActionFailed,
  FortnoxConformanceConfig,
  FortnoxConformanceRestoreFailed,
  FortnoxConformanceSeeds,
  fortnoxArticleListRowNumbersCase,
  fortnoxCompanyInformationCase,
  fortnoxConformanceCases,
  fortnoxConformanceCommentsMarker,
  fortnoxConformanceCredentialRef,
  fortnoxConformanceIntegration,
  fortnoxCostCenterListMatchesGetCase,
  fortnoxCustomerEmptyStringCase,
  fortnoxCustomerListMatchesGetCase,
  fortnoxInboxFolderFileBytesCase,
  fortnoxInvoiceListPopulatedCase,
  fortnoxInvoicePaymentFiltersCase,
  fortnoxInvoicePaymentReadCase,
  fortnoxInvoicePreviewPdfCase,
  fortnoxInvoiceRowDiscountCase,
  fortnoxInvoiceSendEmailCase,
  fortnoxOfferRowsAndPreviewCase,
  fortnoxPredefinedAccountsAndLabelsCase,
  fortnoxPriceTierMatchesSublistCase,
  fortnoxPrintTemplatesUnpaginatedCase,
  fortnoxProfileMeCase,
  fortnoxSettingsCompanyAndLockedPeriodCase,
  fortnoxSettingsRegistersCase,
  fortnoxSupplierInvoicePaymentReadCase,
  fortnoxWriteRejectionCase,
  type FortnoxConformanceCase,
  type FortnoxConformanceError,
  type FortnoxConformanceRequirements,
  type FortnoxConformanceSeedKey
} from './cases.ts'

export { fortnoxConformanceFixtureSeeds } from './seeds.ts'

export {
  fortnoxArticleListRowNumbersFixture,
  fortnoxCompanyInformationFixture,
  fortnoxCostCenterListMatchesGetFixture,
  fortnoxCustomerEmptyStringFixture,
  fortnoxCustomerListMatchesGetFixture,
  fortnoxInboxFolderFileBytesFixture,
  fortnoxInvoiceListPopulatedFixture,
  fortnoxInvoicePaymentFiltersFixture,
  fortnoxInvoicePaymentReadFixture,
  fortnoxInvoicePreviewPdfFixture,
  fortnoxInvoiceRowDiscountFixture,
  fortnoxInvoiceSendEmailFixture,
  fortnoxOfferRowsAndPreviewFixture,
  fortnoxPredefinedAccountsAndLabelsFixture,
  fortnoxPriceTierMatchesSublistFixture,
  fortnoxPrintTemplatesUnpaginatedFixture,
  fortnoxProfileMeFixture,
  fortnoxSettingsCompanyAndLockedPeriodFixture,
  fortnoxSettingsRegistersFixture,
  fortnoxSupplierInvoicePaymentReadFixture,
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
  fortnoxInvoiceSendEmailFixture,
  fortnoxCompanyInformationFixture,
  fortnoxCustomerListMatchesGetFixture,
  fortnoxArticleListRowNumbersFixture,
  fortnoxPriceTierMatchesSublistFixture,
  fortnoxCostCenterListMatchesGetFixture,
  fortnoxInvoicePaymentReadFixture,
  fortnoxSupplierInvoicePaymentReadFixture,
  fortnoxOfferRowsAndPreviewFixture,
  fortnoxPrintTemplatesUnpaginatedFixture,
  fortnoxInboxFolderFileBytesFixture,
  fortnoxSettingsCompanyAndLockedPeriodFixture,
  fortnoxPredefinedAccountsAndLabelsFixture,
  fortnoxSettingsRegistersFixture,
  fortnoxProfileMeFixture
]
