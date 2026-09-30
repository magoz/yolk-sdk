---
'@yolk-sdk/connectors': patch
---

The Microsoft and Notion conformance cases now classify a failed create of their own item with the shared write classification: an HTTP 408 is ambiguous (the item may exist, so the failure carries the manual-recovery advice), like a transport or decoding failure, no status, or a 5xx; any other 4xx stays a definitive rejection.
