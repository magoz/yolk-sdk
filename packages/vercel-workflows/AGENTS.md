# Vercel Workflows

Vercel Workflow-backed agent loop primitives. Package stays Vercel-specific but product-agnostic.

## Role

- Own durable Workflow orchestration contracts over model/tool steps.
- Keep continuation state plain serializable wire data.
- Coordinate model-step, tool-batch-step, close, and error callbacks.
- Carry generic awaiting-input wire data between host tool steps and Workflow hooks.
- Provide deterministic durable stream event id sequencing for JSON-serializable events.
- Provide contract tests for Workflow lifecycle without app auth/provider/tool/UI coupling.

## Boundaries

- No Next routes, server actions, auth, telemetry, provider adapters, app tools, DB, or UI.
- No product transcript persistence; host app owns storage/resume policy beyond Workflow execution stream.
- Host app supplies product route/auth/provider/tool wiring; package-owned `'use workflow'` / `'use step'` exports are allowed only with `@workflow/vitest` coverage.
- Keep Effect runtime work out of workflow orchestration helpers; Effect may run inside host/package step callbacks.
- Import Workflow orchestration APIs from `@yolk-sdk/vercel-workflows`; `./workflow` remains an explicit equivalent subpath.
- Effect-native Workflow client/layer lives under `./effect`: `VercelWorkflows.layer` wraps public `workflow/api`; `VercelWorkflows.layerFromSdk` is the fake SDK seam.

## Design Rules

- Workflow inputs/state use `unknown` wire payloads after host encoding.
- Awaiting-input state stays `unknown` payloads; host app owns HITL hook tokens and response validation.
- Durable event helpers are pure/Effect-native: `sequenceDurableAgentEvent`, `writeDurableAgentEvent`, and `commitThenWriteTerminalEvent`; hosts own storage policy.
- Host-provided durable `streamId`s must be scoped to one independent run/session; clients de-dupe
  by `eventId`, so duplicate ids across runs drop legitimate live events.
- Terminal durable event helpers model commit-before-write ordering only; hosts own persistence and terminal error event shape.
- Keep APIs Workflow-specific and free of app/provider/tool/storage policy.
- Preserve tool result order by original model tool-call order.
- Tool batch steps must return one `ToolResultMessage` per host call, including failed `isError` results, before the next model step.
- Treat cancellation as host-observable state; do not assume Vercel preempts active steps.
- Keep max-turn guard explicit and terminal.
- Step retries are opt-in per model/tool/close step; default is `noWorkflowStepRetry` (`maxAttempts: 1`) because streamed retries can replay chunks.
- `runVercelAgentWorkflow` returns structured terminal status (`Completed`, step failures, `AwaitInputFailed`, `CloseStreamFailed`, `MaxTurnsExceeded`) even after writing errors.
- Destructure callback config before invoking workflow steps/hooks; hook suspension may serialize functions otherwise.
- Test observable runtime contract, not Vercel SDK implementation details.
- `./effect` tests must include fake SDK unit tests plus `@workflow/vitest` directive integration coverage.

## Tests

- Contract tests live under `test/`.
- Test-local rules live in `test/AGENTS.md`.
- Cover no-tool completion, tool continuation, HITL await/resume, tool ordering, step failure, retry policy, close failure, and max-turn guard.
- Run `pnpm --filter @yolk-sdk/vercel-workflows test:workflow` after touching package-owned directive fixtures.
- Use fake step callbacks for pure contract tests; use `@workflow/vitest` for real directive transform/start behavior.
