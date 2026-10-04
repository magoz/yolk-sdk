---
'@yolk-sdk/connectors': minor
---

Add optional `sendUpdates` (`all`, `externalOnly`, `none`) to Google Calendar `create_event`, `update_event`, and `delete_event`, sent as Google's `sendUpdates` query parameter so guests can be emailed invitations, updates, and cancellations. `delete_event` now takes `GoogleCalendarDeleteEventInput`; calls that pass a `GoogleCalendarEventIdInput` instance to its `executeTyped` must switch to the new input (TypeScript accepts the old instance, but typed input validation rejects it at runtime). Untyped `execute`/connector `invoke` callers are unaffected. Action descriptions now state that omitted `sendUpdates` sends no email and that `update_event` attendees replace the whole guest list.
