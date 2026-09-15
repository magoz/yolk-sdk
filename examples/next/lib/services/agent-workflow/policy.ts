// Pure host policy: safe to import from Workflow orchestration (no Effect/DB runtime).
// Lifetime cap bounds reservations, the locked registry row, and Stop sweeps.
export const maxWorkflowChildren = 16

export const workflowToolConcurrency = 4

export const maxChildWorkflowTurns = 32

// Unconfirmed launches remain eligible for late self-admission, but must not strand waiters.
export const childAdmissionWaitMs = 60_000

// Per foreground launch / wait observation: <=32 reads, <=31 durable sleeps (14m21s).
// Exhaustion returns a still-running handle; a later owned lookup can recover the result.
export const maxChildObservationReads = 32

export const childObservationDelayMs = (attempt: number) => [1000, 5000, 15000][attempt] ?? 30_000
