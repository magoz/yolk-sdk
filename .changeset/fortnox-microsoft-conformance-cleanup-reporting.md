---
'@yolk-sdk/connectors': patch
---

Report Fortnox and Microsoft conformance cleanup problems raised during an interruption through `ConformanceCleanupReporter`, as the Dropbox, Notion, Todoist, and Telegram cases already do. Fortnox `withRestore` failed restores, and Microsoft `withOwnItem` failed removals, id-less creates, and ambiguous (`createOutcome: 'unknown'`) creates now hand their full message to the reporter when the case fiber is interrupted or an interruption is pending, then fail exactly as before. Uninterrupted failures and definitive create rejections are not reported.
