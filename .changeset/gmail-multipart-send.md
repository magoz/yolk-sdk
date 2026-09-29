---
'@yolk-sdk/connectors': minor
---

Send 7-bit `gmail.send_message` MIME as one simple multipart media upload to `upload/gmail/v1/users/me/messages/send?uploadType=multipart` (`multipart/related` JSON metadata with `threadId` only when provided, then the decoded `message/rfc822` MIME) so messages with attachments up to Gmail's 35 MiB cap are accepted. MIME containing bytes `>= 0x80` keeps the previous JSON `raw` request. Every send is exactly one request, never resumable or retried; input/output schemas and rejected/unknown status classification are unchanged. Decoded MIME over 35 MiB (`gmailSendMessageMaxBytes`) now fails before credentials or network with `validation_failed` and `underlying: { outcome: 'rejected', retryable: false, reason: 'too_large' }`. `GmailRawMessage` now validates in linear time (same accepted strings and published JSON Schema pattern): the previous regex overflowed the stack on multi-megabyte messages.
