import { CredentialSlot } from '../credential.ts'

export const fortnoxConnectorId = 'fortnox'

export const fortnoxOAuthSlotId = 'fortnox.oauth'

export const fortnoxOAuthAuthorizeUrl = 'https://apps.fortnox.se/oauth-v1/auth'

export const fortnoxOAuthTokenUrl = 'https://apps.fortnox.se/oauth-v1/token'

// Fortnox scopes grant read AND write access. This connector only exposes reads.
export const fortnoxCompanyInformationScope = 'companyinformation'

export const fortnoxCustomerScope = 'customer'

export const fortnoxInvoiceScope = 'invoice'

export const fortnoxSupplierScope = 'supplier'

export const fortnoxSupplierInvoiceScope = 'supplierinvoice'

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
