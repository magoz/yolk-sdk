---
'@yolk-sdk/connectors': patch
---

Fortnox supplier invoice reads accept JSON forms the OpenAPI types do not list. On a live company, `fortnox.list_supplier_invoices` and `fortnox.get_supplier_invoice` failed with `validation_failed` ("Invalid response shape") whenever a reply held at least one invoice (shhhlabs/10x-factory#436). `GivenNumber`, `SupplierNumber`, `InvoiceNumber`, `OCR` and row `ArticleNumber` now decode from strings or integers. `VoucherNumber` and row `Account` decode from integers or integer strings. The `Booked`, `Cancelled`, `Credit` and `PaymentPending` flags decode from booleans or `"true"`/`"false"`, and `""` means unset for both. Row amounts decode from numbers or numeric strings, as for customer invoices and payments. Public `FortnoxSupplierInvoice` types are unchanged.
