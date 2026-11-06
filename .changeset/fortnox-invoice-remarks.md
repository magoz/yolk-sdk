---
'@yolk-sdk/connectors': minor
'@yolk-sdk/emulators': patch
---

Fortnox customer invoices expose `Remarks`, the invoice text (Fakturatext) printed on the invoice. `fortnox.create_invoice` and `fortnox.update_invoice` accept it (at most 1024 characters, like `Comments` now), `FortnoxInvoice` returns it, and the action descriptions tell agents that `Remarks` is printed while `Comments` is an internal note. The Fortnox emulator stores and returns invoice `Remarks` on create, update, and read.

Invoice write rows now use the new `FortnoxInvoiceRowInput`, the writable fields of Fortnox's row payload, instead of the read schema `FortnoxInvoiceRow`. Read-only `PriceExcludingVAT`, `Total`, and `TotalExcludingVAT` are no longer advertised as inputs (Fortnox rejected a written `PriceExcludingVAT` with code 2000321), rows are closed (an unknown row key fails `execute`, agent tool calls, and the invoice input classes' `make` instead of being dropped, which would send a row without its price), `VAT` is an integer, `DiscountType` is `AMOUNT` or `PERCENT`, `Description` and `Unit` follow Fortnox's 255 and 20 character limits, and row fields no longer accept `null`. `FortnoxInvoiceRowInput` is a closed schema with a matching type, not a class: code that built write rows with `FortnoxInvoiceRow.make` must build plain `FortnoxInvoiceRowInput` objects.
