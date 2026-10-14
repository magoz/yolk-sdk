---
'@yolk-sdk/codemode': patch
---

The code mode description, its "more tools" line, and the instructions-mode catalog tell scripts to search and call a read-only tool in the same script when its arguments are clear from the query (`tools[hit.name](args)`), and to call tools that change something only after the model has seen their search hit. A clear read then costs one model step instead of two. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.
