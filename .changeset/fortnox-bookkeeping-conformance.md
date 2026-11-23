---
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
---

Fortnox bookkeeping conformance and emulation. `@yolk-sdk/connectors/fortnox/conformance` adds four seedless `read` cases (25 cases in all): `fortnox.bookkeeping.financial-year-by-id-and-date`, `fortnox.bookkeeping.account-balances-list-get` (a populated account page and its balances), `fortnox.bookkeeping.voucher-list-get-balanced` (a populated voucher page, its series, a voucher whose rows balance, and its file connections), and `fortnox.bookkeeping.sie-file-ibm437` (a type 1 SIE file as PC8 bytes), with synthetic, unverified fixtures. The Fortnox emulator serves the ten bookkeeping reads (`/3/financialyears`, `/3/accounts`, `/3/voucherseries`, `/3/vouchers` and its sublist, `/3/voucherfileconnections`, `/3/sie/{Type}`; 54 routes in all) from new seed keys (`financialYears`, `accounts`, `voucherSeries`, `vouchers`, `voucherFileConnections`, `sieFiles`); voucher and voucher file connection creates stay unemulated.
