---
'@yolk-sdk/codemode': patch
'@yolk-sdk/agent': patch
---

`@yolk-sdk/codemode`: a code mode call abandoned after its script saved a staged plan now names that plan. Before, the re-execution's interrupted result listed the ledgered nested calls but never the plan, so the model never learned its id and digest and could not `review_plan` it. The interrupted result now carries `structuredContent.codemode.plan` (`{ id, digest, count, reviewToolName }`) and the plan notice (`stagedToolPlanNotice`) after the bounded listing, before any input-required notice, as a finished script writes them, so the ledger's bounding keeps them too. `@yolk-sdk/agent/tools`: `ToolLedgerAbandonedInput` gains an optional `plan` (`StagedToolPlanRef`), which `resolveTools` sets for nested-access registrations of a resolution with staged tool plans when the plan store holds an unclaimed, intact plan in its scope under the call's plan id (`plans.planId({ call })`, default the call id); it is never read from model data, and a plan store failure is logged and leaves it unset.
