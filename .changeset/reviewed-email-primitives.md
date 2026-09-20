---
'@yolk-sdk/connectors': patch
---

Add reviewed-email provider primitives: `gmail.send_message` submits complete host-generated base64url MIME for new emails or properly threaded replies, `outlook.update_draft` edits recipients, subject, and full replacement body on an existing draft, and `outlook.reply` sends the complete reviewed reply in one Graph `POST .../reply` with no intermediate mutable draft.

The new `outlook.update_draft` and `outlook.reply` actions reject malformed UTF-16 (lone surrogates) in message and mailbox identities at the schema boundary, before credential or network access, so path encoding can no longer throw outside the typed failure channel. Valid Unicode, including valid surrogate pairs, and slash-containing opaque Graph IDs still encode as complete path segments.

Gmail sending declares destructive access and reports accepted submission, not delivery. It uses the existing Google credential binding with a least-privilege send-scope hint; when OAuth scope metadata carries an existing compose/modify/full-mail grant, the action selects and re-resolves through that operation slot, preserving strict host enforcement without requesting unnecessary consent. The combined scope set is unchanged. MIME construction, header safety, sender/account binding, content review, and authorization remain host-owned.

Outlook draft editing declares write access, preserves existing mailbox permission selection and immutable-ID headers, and retains the existing draft identity for recovery. Omitted fields remain unchanged and empty recipient arrays clear them. Update followed by send is not atomic or compare-and-swap. Neither operation retries automatically; uncertain sends require reconciliation before another attempt.

Outlook direct reply declares destructive access and reuses the existing send-slot mailbox permission selection, mailbox guard, and immutable-ID headers. A required nonempty `to` array, required `cc` and `bcc` arrays that may be empty, `subject`, and the complete `body` travel in the single send request with text defaulting only in the outbound representation; no `comment`, `from`, quoted history, or draft round-trip is involved. Only HTTP 202 Accepted reports `{ accepted: true }`, meaning submission rather than delivery, with no message ID or exactly-once claim. Recognized rejections and ambiguous outcomes carry `underlying: { outcome: 'rejected' | 'unknown', retryable: false }` without retry hints or provider bodies.
