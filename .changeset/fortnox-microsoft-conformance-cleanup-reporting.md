---
'@yolk-sdk/connectors': patch
---

Report Fortnox and Microsoft conformance cleanup problems raised during an interruption through `ConformanceCleanupReporter`, as the Dropbox, Notion, Todoist, and Telegram cases already do. Failed restores in the Fortnox row/customer mutation cases, and failed removals, id-less creates, and ambiguous (`createOutcome: 'unknown'`) creates in the Microsoft write cases, now hand their message to the reporter when the case fiber is interrupted or an interruption is pending, then fail exactly as before; a Microsoft ambiguous create is reported with its case id in front. Uninterrupted failures, definitive create rejections, the Fortnox rejection case, and the Fortnox email send are not reported.
