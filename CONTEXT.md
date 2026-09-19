# Agent interactions

Language for human participation in an agent's work. Reviewing proposed work, authorizing an
operation, and observing its outcome are distinct concepts.

## Language

**Input request**:
A request for information that a person can supply or cancel. Supplying information does not
by itself authorize an operation.
_Avoid_: Permission form

**Action-backed interaction**:
A request in which a person can edit proposed values and authorize one of the offered actions
on the final values.
_Avoid_: Form permissions, ambient permission

**Submission**:
A person's selected action and final values, or their decision to cancel the interaction.
_Avoid_: Execution, success

**Accepted submission**:
The immutable submission chosen to settle one pending interaction. Acceptance does not mean
that its action has started or succeeded.
_Avoid_: Completed action

**Execution receipt**:
The authoritative record of an accepted submission and the observed outcome of its action.
_Avoid_: Permission token

**Unknown outcome**:
An observation that cannot establish whether an action took effect. It is neither proof of
success nor proof that retrying is safe.
_Avoid_: Failed action, safe to retry

## Implementation boundary

The accepted design is [Action-backed interactions](docs/adr/0001-action-backed-interactions.md).
Hosts authenticate and atomically accept an immutable, scoped submission before SDK resume.
Raw responses and transcript events never authorize execution.
