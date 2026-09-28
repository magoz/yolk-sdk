---
'@yolk-sdk/connectors': minor
---

Add host-only `addOutlookAttachment` on `@yolk-sdk/connectors/microsoft` (not a connector action) to attach one file to an existing Outlook draft with the Outlook write slot and mailbox guards: files under 3 MiB use one Graph `fileAttachment` POST; 3 MiB to 150 MiB use `createUploadSession` and sequential pre-authenticated `PUT` ranges with validated `nextExpectedRanges`, a final 201 `Location` attachment ID, and best-effort, time-bounded session cancellation on any failure after session creation. Add the optional `ConnectorBinaryWriteHttpClient.uploadSession` method and `ConnectorBinaryUploadSessionRequest` type; existing adapters still compile and fail session-sized uploads with `upload_session_required` before any request. Session URLs are allowlisted to `https://outlook.office.com/api/{v1.0,v2.0,gv1.0,beta}/.../AttachmentSessions(...)` and never appear in results or errors.
