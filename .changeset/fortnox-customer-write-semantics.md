---
'@yolk-sdk/connectors': minor
---

Align Fortnox customer writes with the Fortnox Customer resource. `FortnoxCreateCustomerInput` and `FortnoxUpdateCustomerInput` no longer accept `Country` (read-only, derived from `CountryCode`) or `Phone` (customers use `Phone1`/`Phone2`), and `fortnox.create_customer` / `fortnox.update_customer` reject unknown keys instead of stripping them. `FortnoxCustomer` and `FortnoxSupplier` responses still include both fields. Fortnox action descriptions now document partial customer updates, invoice row replacement and RowId matching, required pre-existing referenced records, and the observed exclusion of unbooked invoices from payment-status filters.
