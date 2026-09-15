---
'@yolk-sdk/agent': minor
'@yolk-sdk/harness': minor
'@yolk-sdk/knowledge': minor
'@yolk-sdk/vercel-workflows': minor
---

Export canonical tagged constructors on existing subpaths: `PlainHitlResponse` and `RuntimeRequest` values, React chat ADTs, harness inbox/outcome/`StopDecision` companions, knowledge source/scope `.make`, and workflow `WorkflowStepResult` / `VercelAgentWorkflowRunResult`.

`Data.taggedEnum` values are plain objects with `_tag` last, not Equal/Hash classes. Prefer constructors over handwritten `{ _tag }` objects and omit absent optionals.
