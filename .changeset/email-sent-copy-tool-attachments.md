---
'@yolk-sdk/agent': patch
'@yolk-sdk/connectors': patch
---

Add IMAP Sent-copy configuration to generic email submission. Sent saving is requested by default; `saveToSentItems: false` skips it. Legacy hosts receive synthesized `unsupported` or `skipped` status instead of an implied save. Confirmed SMTP acceptance is preserved when ancillary metadata is invalid. Hosts still own MIME rendering and Sent storage; storage failures must not trigger resubmission.

Support tool-result images, readable text documents, and PDFs when `supportsPdfAttachments` is enabled in OpenAI-compatible Chat Completions. Those parts are lowered to origin-labeled supplementary user content after the complete tool-result block. Other native document formats and audio remain unsupported. Validate all content before resolving URL-backed PDFs, preserve canonical history, and continue rejecting unresolved references.
