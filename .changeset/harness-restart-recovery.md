---
'@yolk-sdk/harness': minor
---

Admit in-process restart recovery through the existing Inbox gate with current-key eligibility, a validated finite resume budget, and host-owned HITL re-parking via Driver.run/pause.

Optional factory configuration remains forwardable (`options?: DriverLayerOptions`). Omitted or explicit `undefined` `maxResumeAttempts` stays infallible (`E = never`); a numeric or `number | undefined` config types `InvalidMaxResumeAttempts`.

`resumeSuspended` is an explicit finite sweep: serialize concurrent calls, recheck live claim and coordinator activity at admission, charge or exhaust before granting pending input, and never wait for drain settlement while holding that gate. `Driver.stop` captures `terminalStop` under that same Inbox `invalidate` gate so a stale Idle receipt cannot release a live recovered owner's claim. Invalid `maxResumeAttempts` fails Layer init. Automatic failed-start settlement does not release a prior or unacquired claim. Explicit user interruption or `Driver.stop` still releases an existing leftover claim after that owner has actually settled. Wake/resume schedule work; awaitIdle is quiescence; run observes failures. Persisted partial HITL responses are re-admitted only against a fresh park.
