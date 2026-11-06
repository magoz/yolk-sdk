---
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
---

Fortnox customer invoices expose `Remarks`, the invoice text (Fakturatext) printed on the invoice. `fortnox.create_invoice` and `fortnox.update_invoice` accept it, `FortnoxInvoice` returns it, and the action descriptions tell agents that `Remarks` is printed while `Comments` is an internal note. The Fortnox emulator stores and returns invoice `Remarks` on create, update, and read.
