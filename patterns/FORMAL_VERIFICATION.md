# Formal verification

Yolk's guarantees about concurrent work (ledger claims and leases, plan claims, pin
compare-and-sets, run claims, at-least-once Workflow steps, cleanups that run beside writers) rest
on fiber interleavings, the stores hosts implement, and platform delivery rules, where tests reach
only the orders someone thought to write. A TLA+ model of such a protocol, checked by
`everystate`, checks every order of its steps at small bounds. Why and how this was chosen:
[ADR 0015](../docs/adr/0015-formal-verification.md). The method is the global
`formal-verification` skill; this guide is the repository's part of it.

## When to model

Modelling is optional. It pays off when a change adds or changes:

- a claim, lease, lock or fence (an insert-if-absent, a compare-and-set, a conditional update, a
  `Semaphore`, a heartbeat that extends a lease);
- a single slot (one execution of a ledgered call, one owner of a plan, one claim on a run);
- a step that runs at least once (Workflow steps, drains after a restart) and must not repeat an
  effect;
- anything "at most once" or "exactly once";
- a cleanup or sweep that runs beside writers (`resumeSuspended`, stale-cooldown clearing, expiry);
- one logical write across a host store and an external call (a tool's effect and the ledger entry
  that records it).

The usual place is review: a reviewer running the `formal-verification` skill beside the code
reviewers models what the diff adds or changes in scratch, in minutes, and reports findings like
any reviewer. Commit a model (below) only for a subtle protocol whose code is fairly stable, where
the drift check is worth its upkeep; a protocol that keeps drawing race findings in review is the
signal. Pure functions stay with property tests
([SIMULATION_PROPERTY_TESTING.md](./SIMULATION_PROPERTY_TESTING.md)); in-process timing stays with
`TestClock` tests ([EFFECT_TESTING.md](./EFFECT_TESTING.md)).

Whoever models reports the promise, the bounds, each property with the guard whose removal breaks
it, and every counterexample found with its replay against the code; when a model is committed,
the change states the same.

## Where models live

A model lives in a `formal/` folder beside the code it covers, for example
`packages/agent/src/tools/formal/` for the tool ledger (the names below illustrate one; no model
is committed yet). A package publishes only its `.ts` sources and `dist` (`files` in its
`package.json`), so a model under `src/` never ships.

| File                   | Holds                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `ToolLedger.tla`       | The spec. TLA+ module names match the file name and cannot hold `-`                            |
| `ToolLedger.cfg`       | A configuration that must pass                                                                 |
| `*Unfenced.cfg` (etc.) | A guard removed: breaks the invariant it carries, or passes when another guard also carries it |
| `*.model.json`         | The manifest `pnpm models:check` reads                                                         |

The manifest (`tool-ledger.model.json` in the illustration):

```json
{
  "spec": "ToolLedger.tla",
  "promise": "A ledgered call runs at most once per key, and a completed call keeps its outcome.",
  "covers": [
    {
      "path": "packages/agent/src/tools/ledger.ts",
      "sha256": "<SHA-256 of the file when the model was last confirmed against it>"
    }
  ],
  "checks": [
    { "config": "ToolLedger.cfg" },
    { "config": "ToolLedgerUnfenced.cfg", "violates": "RunsAtMostOnce" }
  ]
}
```

- `spec`: the `.tla` file beside it.
- `promise`: the promise in one plain sentence.
- `covers`: each file whose code the model stands for (repository-relative), with the SHA-256 of
  its content when the model was last confirmed against it. Write each entry `path` first, then
  `sha256`, so `--sync` can update it in place.
- `checks`: each configuration beside the manifest, with `violates` naming the invariant it must
  break. At least one configuration must pass and at least one must break: a check never seen
  failing proves nothing.

Give every invariant the model states a configuration that breaks it, with the guard it rests on
removed. When removing one guard breaks nothing, keep that as a passing configuration: it records
that another guard also carries the promise.

Each action carries a comment naming the function it stands for. Keep bounds small: every
configuration a manifest lists runs in `pnpm check`, so each should finish in seconds. Larger
explorations run locally with `pnpm exec everystate` and are reported in the change, not listed.

## Keeping models true to the code

A model never reads the code, so after the code changes it can keep passing while it describes
code that no longer exists. `pnpm models:check` fails when a covered file's content differs from
the hash in its manifest, naming the file. Then:

1. Re-check the model against the change: compare each action with the function its comment names
   and decide whether the change has no effect on it, changed the steps (update the model from the
   code, then rerun), changed the promise on purpose (cite the evidence), or broke the promise (a
   bug, reported with its counterexample). The global `formal-verification` skill's `maintain`
   mode walks through this.
2. Run `pnpm models:check --sync <manifest>`. It records the covered files as confirmed only while
   every configuration still answers as declared.

A change to comments or formatting trips it too; confirming that takes a minute. Cover only the
files whose logic the model stands for, not every file it mentions. A moved or deleted covered
file needs `covers` edited by hand; `--sync` refuses it.

## Platform assumptions

Yolk is an SDK: hosts supply the stores and run it on their platform. A model assumes only what
the code below and its documented contracts guarantee, and states any other assumption in the
change. A model of `examples/next` or `cloudflare/agent` code adds the guarantees of the database
or platform that code uses, cited from that code.

- **Effect fibers** interleave at every `yield*`: a fiber suspends at each asynchronous step, and
  the scheduler also switches fibers after an operation budget (`MaxOpsBeforeYield` in
  `effect/Scheduler`). Concurrent fibers are ordinary in the SDK: the agent loop runs one turn's
  sibling tool calls concurrently up to `toolConcurrency` (`packages/agent/AGENTS.md`). Only
  synchronous code between two yields, one `Ref` update, or a section a `Semaphore` serializes is
  one step; a `Ref.get` and a later `Ref.set` are two (`RunStore.snapshotLayer` in
  `packages/harness/src/store.ts` serializes its read-modify-save with a `Semaphore` for this
  reason). `Effect.uninterruptible` stops interruption, not interleaving.
- **Host stores** give only the guarantees their interfaces document; model every other operation
  as a plain read or write that can interleave with any other:
  - `ToolLedgerStore` (`packages/agent/src/tools/ledger.ts`): `claim` is one atomic
    insert-if-absent that otherwise classifies the stored entry without changing it; `heartbeat`
    extends the lease of an entry without an outcome, never shortening it, and never changes a
    completed entry; `complete` records the outcome once and ignores a later one; a claim is never
    handed to another execution. `list` is a plain read. Leases use one clock per store, the caller's (`nowMs`) or the store's own (`leaseMs`),
    so a model says which clock each step reads and fires lease expiry as a step of its own.
  - `ToolPlanStore` (`packages/agent/src/tools/plan.ts`): `put` inserts or compares atomically and
    never overwrites; `claim` is one conditional update that is never released; submission ids
    are unique within the store's scope.
  - `PoolStoreApi` (`packages/pool/src/store.ts`): each operation is atomic per key only;
    `movePin` is a compare-and-set, `clearCooldown` removes only the cooldown observed,
    `putCooldown` keeps the cooldown that ends later, and `putReading` the reading fetched later.
    Nothing makes a `load` across keys one snapshot. Store failures never fail a request (`packages/pool/AGENTS.md`).
  - `RunStore` (`packages/harness/src/store.ts`): `claim` returns nothing, so it is a set insert,
    not a compare-and-set. Claims are owned per shared `Driver` instance; the host or platform
    supplies cross-process exclusivity (`packages/harness/README.md`, "Restart contract").
    Recovery is at-least-once, and the memory `Inbox` lasts only as long as its process.
- **Vercel Workflows steps** run at least once: queue redelivery runs a step again after a crash,
  and can run it beside a first execution that is still running, even with `noWorkflowStepRetry`
  (`packages/vercel-workflows/README.md`, "Tool steps are at-least-once"). Cancellation is
  host-observable state; the platform does not preempt a running step
  (`packages/vercel-workflows/AGENTS.md`).
- **Providers, MCP servers and connector APIs** are external calls, each a step of its own: one
  can take effect and its answer be lost (a transport failure or timeout after the write), or the
  next store write (the ledger's `complete`) fail after it succeeded. The ledger reads an
  unrecorded outcome as abandoned and never runs the call again; the model is told it may already
  have been applied (`packages/agent/src/tools/README.md`, "Durable tool ledger"). The SDK claims
  no exactly-once tool or provider effect (`packages/harness/AGENTS.md`).

## Commands

| Command                               | Does                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `pnpm models:check`                   | Runs every manifest's configurations; checks coverage hashes |
| `pnpm models:check --sync <manifest>` | Records the covered files as confirmed, if the model holds   |
| `pnpm exec everystate -json Spec.tla` | Runs one spec ad hoc (`-config X.cfg`)                       |

`pnpm models:check` (`scripts/check-formal-models.ts`) runs in `pnpm check`. It skips hidden
directories (`.git`, `.repos`, `.next`, ...), `node_modules`, `dist` and test output. With no
manifest it passes and says so.

## Models

No model is committed yet. List each committed model here with its promise.
