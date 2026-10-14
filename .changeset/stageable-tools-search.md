---
'@yolk-sdk/codemode': patch
---

Code mode scripts find every stageable tool with `searchTools()` (hits marked `stageOnly: true`), read it with `describeTool()` (rendered as the `stage()` call), and the catalog counts it in its namespace, whatever its `callableBy`. Before, only stage-only (`callableBy: 'codemode'`) tools were searchable, so a model-callable stageable tool was reachable from scripts only through the description's Stageable list, and a deferred one (`loading: 'deferred'`) not at all. Deferred stageable tools are not named in the Stageable list (like `search` tools), and a direct `tools.<name>()` call of any stageable tool rejects with a hint to `stage()` it.
