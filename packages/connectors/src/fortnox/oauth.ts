import { CredentialSlot } from '../credential.ts'

export const fortnoxConnectorId = 'fortnox'

export const fortnoxOAuthSlotId = 'fortnox.oauth'

export const fortnoxOAuthAuthorizeUrl = 'https://apps.fortnox.se/oauth-v1/auth'

export const fortnoxOAuthTokenUrl = 'https://apps.fortnox.se/oauth-v1/token'

// Fortnox scopes grant read AND write access; there is no read-only consent. Action access
// metadata (`read` / `write` / `destructive`) is what hosts gate on, not the scope.
export const fortnoxCompanyInformationScope = 'companyinformation'

export const fortnoxCustomerScope = 'customer'

export const fortnoxInvoiceScope = 'invoice'

export const fortnoxSupplierScope = 'supplier'

export const fortnoxSupplierInvoiceScope = 'supplierinvoice'

// Opt-in resource scopes. They are not part of `FortnoxCombinedOAuthCredentialSlot`, which keeps
// its original five record scopes so existing consent hints do not grow.
export const fortnoxArticleScope = 'article'

export const fortnoxPriceScope = 'price'

export const fortnoxCostCenterScope = 'costcenter'

export const fortnoxPaymentScope = 'payment'

export const fortnoxOfferScope = 'offer'

export const fortnoxPrintScope = 'print'

export const fortnoxInboxScope = 'inbox'

export const fortnoxSettingsScope = 'settings'

export const fortnoxProfileScope = 'profile'

export const FortnoxOAuthCredentialSlot = CredentialSlot.make({
  id: fortnoxOAuthSlotId,
  kind: 'oauth'
})

const scopedSlot = (scope: string) =>
  CredentialSlot.make({ id: fortnoxOAuthSlotId, kind: 'oauth', requiredScopes: [scope] })

export const FortnoxCompanyInformationOAuthCredentialSlot = scopedSlot(
  fortnoxCompanyInformationScope
)

export const FortnoxCustomerOAuthCredentialSlot = scopedSlot(fortnoxCustomerScope)

export const FortnoxInvoiceOAuthCredentialSlot = scopedSlot(fortnoxInvoiceScope)

export const FortnoxSupplierOAuthCredentialSlot = scopedSlot(fortnoxSupplierScope)

export const FortnoxSupplierInvoiceOAuthCredentialSlot = scopedSlot(fortnoxSupplierInvoiceScope)

export const FortnoxArticleOAuthCredentialSlot = scopedSlot(fortnoxArticleScope)

export const FortnoxPriceOAuthCredentialSlot = scopedSlot(fortnoxPriceScope)

export const FortnoxCostCenterOAuthCredentialSlot = scopedSlot(fortnoxCostCenterScope)

export const FortnoxPaymentOAuthCredentialSlot = scopedSlot(fortnoxPaymentScope)

export const FortnoxOfferOAuthCredentialSlot = scopedSlot(fortnoxOfferScope)

export const FortnoxPrintOAuthCredentialSlot = scopedSlot(fortnoxPrintScope)

export const FortnoxInboxOAuthCredentialSlot = scopedSlot(fortnoxInboxScope)

export const FortnoxSettingsOAuthCredentialSlot = scopedSlot(fortnoxSettingsScope)

export const FortnoxProfileOAuthCredentialSlot = scopedSlot(fortnoxProfileScope)

export const FortnoxCombinedOAuthCredentialSlot = CredentialSlot.make({
  id: fortnoxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [
    fortnoxCompanyInformationScope,
    fortnoxCustomerScope,
    fortnoxInvoiceScope,
    fortnoxSupplierScope,
    fortnoxSupplierInvoiceScope
  ]
})
