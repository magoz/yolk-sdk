---
'@yolk-sdk/codemode': patch
---

`searchTools` hits include `signature`: the call on one line with its argument and result types (for example `tools.crm_find({ email: string; }): Promise<string>`, or `stage("name", { … })` for a stageable tool), without description comments and cut at 800 characters (`maxCodeModeSearchSignatureChars`), so a script calls a found tool in its next run without a `describeTool` round trip. New export `codeModeToolSignature`. The code mode description says so, and its `store()` line now invites keeping large fetched data (up to 256 KiB per value) and filtering it in a later script instead of fetching it again. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.
