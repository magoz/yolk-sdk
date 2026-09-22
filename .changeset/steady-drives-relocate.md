---
'@yolk-sdk/connectors': patch
---

Add Microsoft OneDrive same-drive move, asynchronous copy acceptance, and copy-status polling. Polling sends no credential to the monitor URL and requires host adapters to honor `redirect: 'manual'` and `credentials: 'omit'`. Monitor URLs are secrets. Microsoft failures now match `Retry-After` case-insensitively and ignore ambiguous, non-integer, or unsafe delay values.
