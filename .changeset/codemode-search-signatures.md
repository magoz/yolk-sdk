---
'@yolk-sdk/codemode': minor
---

`searchTools` hits include `signature`: the call on one line with its argument and result types (for example `tools.crm_find({ email: string; }): Promise<string>`, or `stage("name", { … })` for a stageable tool), without description comments and at most 800 characters (`maxCodeModeSearchSignatureChars`; a longer one is cut with a `describeTool` pointer), so a script calls a found tool in its next run without a `describeTool` round trip. New exports `codeModeToolSignature` and `maxCodeModeSearchSignatureChars`; `CodeModeSearchHit` gains the required `signature` field. The code mode description says so, and its `store()` line now invites keeping large fetched data (up to 256 KiB per value) and filtering it in a later script instead of fetching it again. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.
