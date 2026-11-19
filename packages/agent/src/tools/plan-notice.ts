import * as Schema from 'effect/Schema'

/** A saved staged tool plan as a staging result names it (code mode's
 * `structuredContent.codemode.plan`): the review tool and what the model passes to it.
 */
export const StagedToolPlanRef = Schema.Struct({
  id: Schema.String,
  digest: Schema.String,
  count: Schema.Number,
  reviewToolName: Schema.String
})

export type StagedToolPlanRef = typeof StagedToolPlanRef.Type

/**
 * The model-visible sentence naming a saved staged plan and the review call that applies it
 * (ADR 0005). Code mode writes it after the bounded output, before any input-required notice. The
 * tool ledger matches this exact text to keep the plan and its notice when it cuts a stored copy,
 * so writers use this function, never a copy of the text.
 */
export const stagedToolPlanNotice = (plan: StagedToolPlanRef) =>
  `Staged ${plan.count} call${plan.count === 1 ? '' : 's'} as plan ${plan.id}; nothing was applied yet. To apply them, call ${plan.reviewToolName}(${JSON.stringify({ planId: plan.id, planDigest: plan.digest })}): a person reviews the plan and selects the calls to apply.`
