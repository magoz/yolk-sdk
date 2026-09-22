---
'@yolk-sdk/agent': patch
'@yolk-sdk/connectors': patch
---

Add optional IMAP Sent-copy configuration and status to generic email submission while preserving confirmed SMTP acceptance when ancillary metadata is invalid. Hosts retain ownership of MIME rendering and Sent storage; storage failures must not trigger resubmission.

Support image and document tool-result content in OpenAI-compatible Chat Completions by lowering it to origin-labeled supplementary user content after the complete tool-result block. Validate all content before resolving URL-backed PDFs, preserve canonical history, and continue rejecting unsupported audio and unresolved references.
