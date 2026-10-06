---
'@yolk-sdk/agent': minor
---

Add tool change previews (ADR 0006): one tool-agnostic before → after diff for every approval-gated call, rendered the same way for direct approvals, sibling approvals, and staged plan reviews.

- New Effect Schemas in `@yolk-sdk/agent/protocol` (re-exported from `/tools`): `ToolChangePreview` (`target`, `summary?`, `changes`, `warnings?`, `blocked?`), `ToolFieldChange` (`Value`, `Text`, `Set`, `List`, `Structured`), `ToolChangeTarget`, `ToolChangeItem`, `ToolChangeScalar`, cut markers `ToolChangeCut`/`ToolChangeSideCuts`/`ToolChangeSetCuts`, `ToolChangePreviewError`, and the `ToolApprovalPreviewer` loop seam.
- One hook: `makeTool({ approval, changePreview })` (decoded arguments) or `ToolRegistration.changePreview`, only on approval-gated tools (new `ToolRegistryError` cause `change_preview_unsupported_policy`). `resolveTools(..., { changePreview: { maxBytes, timeoutMs } })` bounds previews (default 16 KiB, 5 s).
- Approvals: pass `ResolvedToolSet.approvalPreviews` as `approvalPreviews` to `run`, `runToolBatch`, `prepareToolBatch`, or `RuntimeConfig`; pending `ToolApprovalRequest`s (and their `ToolApprovalRequested` events) then carry `preview` or `previewError`. A failing preview never blocks the approval, and approval ids are unchanged. Voice ignores previews.
- Staged plans: `previewToolPlan`/`previewStoredToolPlan` run the same hook. `ToolPlanPreview` `ok` entries carry `params` plus `preview: ToolChangePreview` or `previewError`; a failing preview no longer becomes an error entry.
- Large previews are truncated deterministically with `truncated` markers (original size, unit, window offset), never silently; `boundToolChangePreview` is exported. `toolChangeSignature`, `groupToolChangePreviews`, and `isToolChangePreviewTruncated` group identical changes per tool.
- Breaking (canary): `staging.preview` (`ToolStaging`/`ToolStagingHandlers`) and `maxToolPlanPreviewBytes` are removed; move previews to `changePreview` returning a `ToolChangePreview` and use `defaultToolChangePreviewMaxBytes`. `ResolvedToolSet` has a new required `approvalPreviews` field.
