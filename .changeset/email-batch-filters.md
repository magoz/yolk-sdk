---
'@yolk-sdk/connectors': minor
---

Add portable email read/flag discovery and filtered listing, explicit batch mailbox mutations, and UID-scoped permanent deletion contracts with additive host methods and validated per-message outcomes.

Gmail reports read state from the `UNREAD` label and flag state from the `STARRED` label (absent when labels are omitted), with matching typed filters on search/list, an explicit `gmail.set_read`, and individually addressed batch mutations plus immediate permanent deletion behind opt-in full-mail consent. Outlook reports `isRead` with follow-up flag state as `isFlagged`, typed list filters composed into `$filter`, and Graph JSON-batched mutations plus `permanentDelete`, which enters Recoverable Items rather than erasing retained data. Providers keep their native organization models (Gmail labels, Outlook flags/folders/categories, IMAP flags/keywords/folders); batch reports return complete per-ID outcomes with exact counts and sanitized codes only, and every succeeded generic move-shaped result requires destination `folder`.
