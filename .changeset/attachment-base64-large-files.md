---
'@yolk-sdk/agent': patch
'@yolk-sdk/connectors': patch
---

Fix attachments above ~3.3 MB. `gmail.get_attachment`, `email.get_attachment` and `outlook.get_attachment` no longer pattern-check the attachment base64: the grouped regex overflowed V8's regexp stack past ~4.4M characters (`RangeError: Maximum call stack size exceeded`), so every larger attachment failed. `GmailAttachmentBase64Url`, `GmailAttachmentBase64` and `EmailAttachmentBase64` are now plain strings (no published `pattern`); whoever decodes the bytes validates them. `downloadGmailAttachment` keeps its alphabet, padding and size checks but no longer re-encodes to compare (unused pad bits are accepted). Tool file capture, `attachmentSourceText` and the Gmail decoders copy decoded bytes into one preallocated array instead of `Uint8Array.from(binary, mapFn)` (about 0.7 GB of memory for a 20 MiB file). New `base64ToBytes` in `@yolk-sdk/agent/protocol`.
