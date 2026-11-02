---
'@yolk-sdk/agent': patch
'@yolk-sdk/vercel-workflows': patch
---

Some boundary failures are now typed instead of the global `Error` or `unknown`. Message texts are unchanged; each error keeps the original failure as `cause`.

- `@yolk-sdk/agent/client`: `textFromBlob` and `documentPartFromTextFile` fail with the new `BlobTextReadError` instead of `Error`.
- `@yolk-sdk/agent/protocol`: `attachmentSourceText` fails with the new `AttachmentTextDecodeError` instead of `unknown`.
- `@yolk-sdk/vercel-workflows`: `writeDurableAgentEvent` fails with the new `DurableAgentEventWriteError` instead of the writer's raw rejection. Its `message` is the rejection's message (or `String(rejection)` when it is not an `Error`), and `cause` is the rejection itself, so code that inspected the raw rejection reads `cause`.
