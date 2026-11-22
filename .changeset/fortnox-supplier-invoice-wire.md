---
'@yolk-sdk/connectors': patch
---

Fortnox supplier invoice reads accept JSON forms the OpenAPI types do not list. On a live company, `fortnox.list_supplier_invoices` and `fortnox.get_supplier_invoice` failed with `validation_failed` ("Invalid response shape") whenever a reply held at least one invoice. `GivenNumber`, `SupplierNumber`, `InvoiceNumber`, `OCR`, `CostCenter`, `Project` and the row `ArticleNumber`, `CostCenter` and `Project` now decode from strings or integers. `VoucherNumber` and row `Account` decode from integers or integer strings (`""` is unset). The `Booked`, `Cancelled`, `Credit` and `PaymentPending` flags decode from booleans or `"true"`/`"false"` (`""` is unset). Row amounts decode from numbers or numeric strings, as for customer invoices and payments. Public `FortnoxSupplierInvoice` types are unchanged.

A Fortnox amount sent as a JSON number past the double range (which parses to `Infinity`) now fails the read with `validation_failed` for customer invoices, supplier invoices and payments, instead of throwing when the public schema re-checked it.
