---
'@yolk-sdk/emulators': patch
---

Internal refactor: the Todoist and Telegram emulators now run on the same internal stateful wrapper
as the Dropbox, Notion, GitHub, Google, LinkedIn search, and MCP emulators, through new opt-ins
(a resolved mode, `json-or-empty` bodies, header-free ledger entries, recovery texts). The second
wrapper is removed, and the emulators share one `@emulators/core` adapter. The other emulators do
not change. Todoist and Telegram keep their answers, ledger entries, and control plane, with these
exceptions:

- A fault whose `match.route` names no manifest route is now rejected, both by `faults.add`
  (`TodoistEmulatorInputInvalid` / `TelegramEmulatorInputInvalid`) and by `POST /_emulate/faults`
  (400). Before, it was accepted and never matched anything.
- Each request's eligibility check, fault decision, and commit now run atomically, so concurrent
  requests never interleave.
