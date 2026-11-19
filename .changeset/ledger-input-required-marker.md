---
'@yolk-sdk/agent': patch
---

`@yolk-sdk/agent/tools`: the tool ledger keeps an input-required result's marker and its review call when the result is over `maxResultBytes`. `toolLedgerResult` now keeps the `{ code: 'input_required', inputRequired }` marker (dropping only other `structuredContent` fields) and cuts the text before the review call, which it keeps (or rebuilds from the marker). Before, it dropped the marker and cut the review call off the end of the text, so a replayed call (a redelivered step, an interrupted plan apply's listing, code mode's abandoned-script listing) read as an ordinary failure and its pauses were never reviewed.
