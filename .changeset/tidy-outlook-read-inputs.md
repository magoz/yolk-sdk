---
'@yolk-sdk/connectors': patch
---

Normalize null and blank optional inputs for Outlook message search and listing, including null page sizes, before execution. Direct connector callers and generated agent tools now share the compatibility behavior while preserving real cursors, input validation, application-mailbox guards, and provider failures.
