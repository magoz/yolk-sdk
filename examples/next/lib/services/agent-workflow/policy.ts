// Pure host policy: safe to import from Workflow orchestration (no Effect/DB runtime).
// Lifetime cap bounds reservations, the locked registry row, and Stop sweeps.
export const maxWorkflowChildren = 16
export const workflowToolConcurrency = 4
export const maxChildWorkflowTurns = 32
// Unconfirmed launches remain eligible for late self-admission, but must not strand waiters.
export const childAdmissionWaitMs = 60_000
