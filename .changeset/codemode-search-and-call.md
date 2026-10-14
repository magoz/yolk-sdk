---
'@yolk-sdk/codemode': patch
---

The code mode description, its "more tools" line, and the instructions-mode catalog let a script search and call a read-only tool in the same run when it picks the hit by the exact name it expects (`hits.find(h => h.name.endsWith("find_contact"))`, never the first hit blindly), and to call a found tool that changes something only in a later script, after its hit came back to the model. A clear read then costs one model step instead of two. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.
