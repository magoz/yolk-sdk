---
'@yolk-sdk/connectors': patch
---

Fix `gmail.draft_delete`: Gmail answers a draft delete with HTTP 204 and an empty body, which the action used to JSON-decode, so every successful delete failed with `validation_failed` ("Invalid JSON response"). It now treats any 2xx as success without reading the body and returns `{ id, deleted: true }`, like `gmail.delete_label`; non-2xx answers still map to provider failures. The other Google actions whose endpoints answer an empty body (`gmail.delete_label`, `gmail.delete_permanently`, `calendar.delete_event`, `drive.delete_file`) already never decode it.
