---
'@yolk-sdk/connectors': minor
---

Add `outlook.set_read`, `outlook.trash`, and `outlook.untrash` actions through Microsoft Graph with mailbox-aware write permissions. Add matching generic email actions for IMAP through optional `EmailClient.setRead`, `trash`, and `untrash` host methods, preserving existing adapters and rejecting POP3 mutations. Restore defaults to the inbox or an explicit destination, not the original folder.
