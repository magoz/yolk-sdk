---
'@yolk-sdk/connectors': patch
---

Add optional `sendUpdates` (`all`, `externalOnly`, `none`) to Google Calendar `create_event`, `update_event`, and `delete_event`, sent as Google's `sendUpdates` query parameter so guests can be emailed invitations, updates, and cancellations. `GoogleCalendarDeleteEventInput` builds a typed delete with `sendUpdates`; existing `GoogleCalendarEventIdInput` delete inputs keep working. Action descriptions now state that omitted `sendUpdates` normally sends no email and that `update_event` attendees replace the whole guest list.
