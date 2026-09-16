---
'@yolk-sdk/agent': patch
---

Tag OpenCode Go Responses assistant text that precedes host function calls as `phase: commentary` on replay. Preserve ordered text/call segments through streaming, JSON fallback, and completion-only responses; trailing and final-answer text omit phase. Codex and Grok shared Responses lowering stays untagged.
