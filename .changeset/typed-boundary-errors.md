---
'@yolk-sdk/agent': patch
'@yolk-sdk/vercel-workflows': patch
---

Some boundary failures are now typed instead of the global `Error` or `unknown`. Each error keeps the original failure as `cause` when one exists.

- `@yolk-sdk/agent/client`: `textFromBlob` and `documentPartFromTextFile` fail with the new `BlobTextReadError` instead of `Error`, with the same message (`Could not read text`).
- `@yolk-sdk/agent/protocol`: `attachmentSourceText` fails with the new `AttachmentTextDecodeError` instead of the raw decoding error; its `message` is that error's message.
- `@yolk-sdk/vercel-workflows`: `writeDurableAgentEvent` fails with the new `DurableAgentEventWriteError` instead of the writer's raw rejection. Its `message` is the rejection's message (or `String(rejection)` when it is not an `Error`), and `cause` is the rejection itself, so code that inspected the raw rejection reads `cause`.
