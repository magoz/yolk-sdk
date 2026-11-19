# Formal verification of concurrency protocols

Status: accepted.

Yolk's guarantees about concurrent work live in protocols spread across fibers, host stores and
platform delivery: the tool ledger's claim, lease and completion, the plan store's single-use
claim, the pool's pin compare-and-set and cooldown clearing, the harness's run claims and restart
sweep, and Workflow steps that the queue delivers at least once and may run twice at the same time.
An interleaving bug in one of them shows only when someone traces every concurrent actor by hand,
and tests reach only the orders someone thought to write. A model checker explores every order of
a protocol's steps at small bounds, and most design races show at two actors and a few steps, so
the hand tracing becomes a check that also fails on the next change.

Making a model a requirement for every protocol change costs more than it returns: a committed
model draws review effort to itself (the functions it names, the files it covers, the assumptions
it states) rather than to the change, and it must be kept in step with the code. Modelling a diff
in review, from only the diff and the code, finds the same kind of race in minutes and skips
changes without concurrency at once. The thinking a model forces pays off at review time, without
a file to maintain.

## Decision

- Concurrency protocols are modelled in TLA+ and checked with `everystate`, a TLA+ model checker
  with TLC's language and output, shipped as prebuilt native binaries and a WebAssembly build (no
  Java). Its specs are plain TLA+, so a model runs on TLC unchanged if `everystate` has to be
  replaced.
- Modelling is optional. The usual place is review: a reviewer running the global
  `formal-verification` skill beside the code reviewers triages the diff, models what it adds or
  changes in scratch, and reports findings as any reviewer does. The skill holds the method (model
  only steps atomic in the real system, show each property failing with its guard removed, replay
  every counterexample against the code before calling it a bug). The repository holds only its
  own part: `patterns/FORMAL_VERIFICATION.md` (when to model, where models live, the platform
  assumptions every model uses), the committed models, and the check.
- A model is committed only for a subtle protocol whose code is fairly stable, where a drift check
  on later edits is worth its upkeep. It lives in a `formal/` folder beside its code, with a
  manifest naming the files it covers and their SHA-256 when last confirmed, at least one
  configuration that must pass and at least one that must break a named invariant.
- `pnpm models:check` (`scripts/check-formal-models.ts`) runs every committed configuration and
  fails when one does not answer as declared or a covered file changed since the model was last
  confirmed; `--sync <manifest>` re-confirms the hashes once the model still holds. It runs in
  `pnpm check`, the repository's gate, and passes when no model is committed.
- Drift is detected by content hashes, not a recorded commit: squash merges rewrite commits, and a
  check must not depend on git history.
- `everystate` is a young, single-maintainer native binary, so it is pinned exactly (`0.3.1`), at
  a release that was more than a day old when adopted, so it meets pnpm 11's default minimum
  release age (one day; `pnpm-workspace.yaml` sets no other) without an exception. Move it
  deliberately, to a release that has aged. It has no install script and runs only in
  `pnpm models:check` and in its own tests under `pnpm test:tooling` (which run the real checker
  on temporary models): not in the Vercel builds and not in the package publish workflow.

## Alternatives

- **A model required with every protocol change.** Rejected for the review cost above.
- **Proving invariants over the source with an SMT solver.** It needs the logic written as pure
  functions over typed state. Yolk's guarantees rest on fiber interleaving, host store contracts
  and platform delivery, which no source-level prover sees, and its pure functions are already
  covered by property tests (`patterns/SIMULATION_PROPERTY_TESTING.md`).
- **TLC.** The reference checker, but it needs a Java toolchain on every machine that runs the
  check.

## Consequences

- Editing a file a committed model covers fails `pnpm check` until the model is re-checked and
  re-confirmed (`--sync`), including for comment-only edits.
- Scratch models leave no record beyond the review that used them; a protocol that keeps drawing
  race findings is the signal to commit one.
- Modelling in review finds races in shared state and protocols, and misses UI lifecycle races and
  bugs in tests, which stay with the code reviewers.
- A model is only as good as its assumptions. Yolk's are the guarantees its own code and its store
  interfaces document; when a result depends on behaviour nobody verified, the finding says so
  instead of claiming a bug.
