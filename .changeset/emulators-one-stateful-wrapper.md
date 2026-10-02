---
'@yolk-sdk/emulators': patch
---

Internal refactor: the Todoist and Telegram emulators now run on the same internal stateful wrapper
as the Dropbox, Notion, GitHub, Google, LinkedIn search, and MCP emulators, through new opt-ins
(a resolved mode, `json-or-empty` bodies, header-free ledger entries, recovery texts). The second
wrapper is removed, and the emulators share one `@emulators/core` adapter. The other emulators do
not change. Todoist and Telegram keep their answers, ledger entries, and control plane, with these
exceptions:

- Invalid fault statuses get a different rejection text (for a status of 200, for example,
  `fixture-only emulators take fault statuses of 400 or above` instead of
  `Expected a value between 400 and 599`). The set of accepted statuses (400-599) does not change.
- A fault whose `match.route` names no manifest route is now rejected, both by `faults.add`
  (`TodoistEmulatorInputInvalid` / `TelegramEmulatorInputInvalid`) and by `POST /_emulate/faults`
  (400). Before, it was accepted and never matched anything.
- Each request's eligibility check, fault decision, and commit now run atomically, so concurrent
  requests never interleave.
