---
'@yolk-sdk/connectors': patch
---

Accept JSON null on optional Fortnox response fields. Fortnox uses null for unset values, so strict optional schemas rejected successful company, customer, invoice, and supplier responses.
