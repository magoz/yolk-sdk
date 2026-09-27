---
'@yolk-sdk/connectors': patch
---

Accept Fortnox invoice amounts sent as numeric strings at the wire boundary. Invoice list rows send fields like `CurrencyRate` as strings while single-invoice reads send numbers, so `FortnoxInvoiceApi` now decodes numbers, trimmed numeric strings, null, or absence for `Total`, `Balance`, `TotalVAT`, `TotalToPay`, `Net`, `Gross`, and `CurrencyRate` (`""` means unset; other non-numeric strings still fail). `FortnoxSupplierInvoiceApi` additionally accepts finite JSON numbers for `Total`, `Balance`, and `CurrencyRate` and records their string form. Public invoice types are unchanged. Also harden the invoice preview download: it sends no `Accept` header and verifies `%PDF-` magic bytes instead of requiring an `application/pdf` content type. `ConnectorFileTransferError` gains an optional HTTP `status` number set for every non-success status branch.
