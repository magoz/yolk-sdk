---
'@yolk-sdk/connectors': patch
---

Fix Microsoft Outlook mailbox scope selection, reply-draft history preservation, and attachment listing compatibility.

- Delegated access to an explicit `mailbox` now selects ordinary `Mail.Read` / `Mail.ReadWrite` / `Mail.Send` slots when the mailbox case-insensitively equals the resolved `OAuthCredential.accountId` (still addressed at `/users/{mailbox}`); Bearer credentials, missing account identity, or any mismatch keep `Mail.*.Shared` slots, and application-mode guards are unchanged. Explicit-mailbox delegated actions resolve identity through the scope-free `microsoft.oauth` binding slot before the enforcing operation slot.
- `outlook.create_reply_draft` no longer posts a replacement `message.body`. It creates the reply draft without a body so Graph generates the quoted history, then PATCHes the draft with the supplied reply prepended (inside the generated HTML body element for HTML, newline-joined for text). If saving or reading back the generated body fails after creation, it returns a failure naming the created draft id with edit-instead-of-recreate guidance; no retry or cleanup delete.
- `outlook.list_attachments` selects only base attachment properties (`contentId` is a `fileAttachment`-derived property and is no longer selected across the polymorphic collection) and tolerates explicit null `lastModifiedDateTime` values in list and single-attachment responses.
