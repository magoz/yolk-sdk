---
'@yolk-sdk/codemode': patch
---

The code mode description, its "more tools" line, and the instructions-mode catalog tell the model to call a tool whose exact name it already knows (listed, returned by an earlier `searchTools`, or called earlier in the session) directly, without searching again, and never to call a tool in the same script that found it: search ranking is lexical and hits carry no access metadata, so an unseen hit could be a write. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.
