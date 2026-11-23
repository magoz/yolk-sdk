---
'@yolk-sdk/connectors': minor
---

Fortnox bookkeeping: eleven new actions behind the opt-in `bookkeeping` scope (`FortnoxBookkeepingOAuthCredentialSlot`, not on the combined slot) and the existing `connectfile` scope.

- Reads: `fortnox.list_financial_years`, `fortnox.get_financial_year` (by `id` or by a `date` it contains), `fortnox.list_accounts` and `fortnox.get_account` (per financial year, with the opening `BalanceBroughtForward` and closing `BalanceCarriedForward` balances), `fortnox.list_voucher_series`, `fortnox.list_vouchers` (per financial year and series, with date and cost center filters and pagination), `fortnox.get_voucher` (series, number, and financial year, with rows), and `fortnox.list_voucher_file_connections`.
- `fortnox.create_voucher` is `destructive`: Fortnox books the voucher at once and its API cannot delete or change it. Its closed input is checked before sending: at least two rows, exactly one positive `Debit` or `Credit` per row with at most two decimals, and total debit equal to total credit.
- `fortnox.create_voucher_file_connection` (`write`, `connectfile`) attaches an archive file to a voucher. The new host-only `uploadFortnoxArchiveFile` uploads a file to the archive (`archive` scope) and returns its `Id`.
- `fortnox.get_sie_file` returns a financial year's SIE file (types 1 to 4) as untouched IBM437 bytes. As an agent tool the bytes become a file (`fileOutput`), never text in the model's context. It reads the optional host `ConnectorBinaryHttpClient` and fails with `validation_failed` when the host provides none.

Responses accept the JSON forms of Fortnox's archived examples beyond its OpenAPI types (for example `Project: 0`). None of these endpoints is observed against a live company yet.
