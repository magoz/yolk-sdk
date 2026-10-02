---
'@yolk-sdk/emulators': patch
---

Fault-status validation on the fixture-only emulators (Dropbox, Notion, Todoist, Telegram, GitHub, Google, LinkedIn search, MCP, and the fixture-only routes of OpenCode Go and subscription usage) now uses one 400-599 range check. A rejected status names the range actually accepted (`Expected a value between 400 and 599`), where it previously named 200-599 or said "400 or above". The accepted statuses do not change.
