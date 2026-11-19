---
'@yolk-sdk/agent': patch
---

`@yolk-sdk/agent/tools`: the tool ledger keeps a code mode result's staged plan when the result is over `maxResultBytes`. `toolLedgerResult` now keeps `structuredContent.codemode.plan` (`{ id, digest, count, reviewToolName }`, with `ok` and any kept `inputRequired`) and its plan notice as uncut text, only when the text ends with that notice where code mode writes it (last, or followed by the kept input-required notice). Before, it dropped the plan and cut its notice off the end of the text, so a replayed script (a redelivered step) no longer named the plan id and digest `review_plan` needs. Another tool's result with that shape but no notice keeps neither (the ledger never writes the notice itself). The notice text now comes from the new `stagedToolPlanNotice` export, which `@yolk-sdk/codemode` uses (its result text is unchanged). Ledger entries recorded before this fix are not repaired: their stored copies stay as they were recorded.
