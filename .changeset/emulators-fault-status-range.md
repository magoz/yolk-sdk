---
'@yolk-sdk/emulators': patch
---

Fault-status validation on the fixture-only emulators (Dropbox, Notion, GitHub, Google, LinkedIn search, MCP, and the fixture-only routes of OpenCode Go and subscription usage) now uses one 400-599 range check, as Todoist and Telegram always have. A rejected status names the range actually accepted (`Expected a value between 400 and 599`), where it previously named 200-599, said "400 or above", or (for a 204, 205, or 3xx status) gave that status's specific reason. The accepted statuses do not change.
