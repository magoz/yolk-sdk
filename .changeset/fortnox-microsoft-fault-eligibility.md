---
'@yolk-sdk/emulators': patch
---

Fortnox and Microsoft Graph emulators now check eligibility before using up a fault (plan → fault →
commit), like the later stateful emulators. Before, a request the route refused could use up a
matching fault. That covered a provider-envelope 404 for an unknown id, a 400 for an invalid state
or a value the route does not emulate, and a Microsoft 409 conflict. Each refusal is still answered
and ledgered as before, but now leaves the fault for the next request the route would answer
successfully. A faulted request still writes nothing. On Microsoft Graph it also creates no copy
monitor and holds no message for the conflict window. A route handler that throws partway now
writes nothing too.
