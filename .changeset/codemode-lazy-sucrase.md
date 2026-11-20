---
'@yolk-sdk/codemode': patch
---

`@yolk-sdk/codemode/cloudflare` loads Sucrase when the Dynamic Worker executor runs its first script instead of on import, so a Worker that builds the executor but runs no script does not evaluate it. A Sucrase load failure answers `Could not load the script sandbox.` (`onInternalError` stage `load`).
