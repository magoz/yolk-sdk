---
'@yolk-sdk/connectors': minor
---

Add Gmail label create/get/update/delete plus starring, `outlook.move_message` and flagging plus Outlook master-category list/get/create/update/delete and message category assignment with required internet headers on get, plus required RFC 5322 headers on generic IMAP/POP3 get (breaking for existing `EmailClient` hosts that omit `headers`, now runtime-validated), optional host-backed IMAP keyword label mutations (`email.modify_labels`), flagging (`email.set_flag`), generic IMAP message relocation (`email.move`), and a pure `List-Unsubscribe` parser with spam-report and unsubscribe recipes. Preserve existing email adapters and document provider-specific permissions, non-atomic Outlook merges, destination UID remapping, and POP3/SMTP limitations.
