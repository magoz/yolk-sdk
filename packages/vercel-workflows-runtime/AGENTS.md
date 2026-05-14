# Vercel Workflows Runtime

Runtime primitives for Vercel Workflow-backed agent loops. Package stays Vercel-specific but product-agnostic.

## Role

- Own durable Workflow orchestration contracts over model/tool steps.
- Keep continuation state plain serializable wire data.
- Coordinate model-step, tool-batch-step, close, and error callbacks.
- Provide contract tests for Workflow lifecycle without app auth/provider/tool/UI coupling.

## Boundaries

- No Next routes, server actions, auth, telemetry, provider adapters, app tools, DB, or UI.
- No product transcript persistence; host app owns storage/resume policy beyond Workflow execution stream.
- Host app supplies product route/auth/provider/tool wiring; package-owned `'use workflow'` / `'use step'` exports are allowed only with `@workflow/vitest` coverage.
- Keep Effect runtime work out of workflow orchestration helpers; Effect may run inside host/package step callbacks.
- Import Workflow orchestration APIs from `@yolk/vercel-workflows-runtime/workflow`; root export is intentionally empty.

## Design Rules

- Workflow inputs/state use `unknown` wire payloads after host encoding.
- Keep Workflow-safe APIs behind the `./workflow` package subpath so normal imports do not accidentally couple to Workflow runtime code.
- Preserve tool result order by original model tool-call order.
- Treat cancellation as host-observable state; do not assume Vercel preempts active steps.
- Keep max-turn guard explicit and terminal.
- Step retries are opt-in per model/tool/close step; default is `noWorkflowStepRetry` (`maxAttempts: 1`) because streamed retries can replay chunks.
- Test observable runtime contract, not Vercel SDK implementation details.

## Tests

- Contract tests live under `test/`.
- Cover no-tool completion, tool continuation, tool ordering, step failure, retry policy, close failure, and max-turn guard.
- Run `pnpm --filter @yolk/vercel-workflows-runtime test:workflow` after touching package-owned directive fixtures.
- Use fake step callbacks for pure contract tests; use `@workflow/vitest` for real directive transform/start behavior.
