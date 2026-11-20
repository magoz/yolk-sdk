---
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
---

Add fourteen `read` Fortnox conformance cases to `@yolk-sdk/connectors/fortnox/conformance` (company information, the customer list, and the article, price, cost center, invoice and supplier invoice payment, offer and offer preview, print template, inbox and inbox file, company settings and locked period, predefined account and label, settings register, and profile reads), each with a synthetic `unverified` fixture shaped from the Fortnox API reference and its archived examples (the fixtures are the source of the emulator's read answers). They take no seed: each reads back the first row a list answers through the real connector actions and claims only decoding and read-back. Every `@yolk-sdk/emulators/fortnox` route now cites a conformance case in `fortnoxEmulatorRoutes`: `GET /3/companyinformation`, `GET /3/customers`, and the 34 read-only routes no longer cite none, and the default emulator answers every read fixture request with the fixture's body byte for byte. The default supplier invoice payment now carries a voucher (`VoucherNumber` 2, `VoucherSeries` `D`, `VoucherYear` 3).
