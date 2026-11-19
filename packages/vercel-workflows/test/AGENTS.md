# Workflow Runtime Tests

Tests for Vercel Workflow orchestration contracts and package-owned directive fixtures.

## Files

| File                                     | Role                                                              |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `workflow-loop.test.ts`                  | Pure contract tests with fake step callbacks                      |
| `workflow-events.test.ts`                | Durable event sequencing and terminal commit barrier tests        |
| `workflow-event-executions.test.ts`      | Retried model-step executions keep distinct event ids             |
| `effect.test.ts`                         | Fake `workflow/api` SDK unit tests for `./effect` client/layer    |
| `package-directives.integration.test.ts` | `@workflow/vitest` directive/start/stream/hook/cancel tests       |
| `testing.test.ts`                        | `TestWorkflowWorld` emulator contract, step-error fidelity        |
| `testing-workflow-mock.test.ts`          | `TestWorkflowWorld` under `vi.mock('workflow')`                   |
| `fixtures/workflow-fixture.ts`           | Test-only workflow/step directive fixture; not published          |
| `cloudflare-execution.test.ts`           | Cloudflare runtime execution over the memory run store            |
| `cloudflare-runtime.test.ts`             | `WorkflowRun` on `node:sqlite` through the `workflow/api` drop-in |
| `cloudflare-fakes.ts`                    | Fake `WORKFLOW_RUNS` namespace, Durable Object SQL, RPC gates     |
| `cloudflare-workers-stub.ts`             | `cloudflare:workers` stub the package Vitest aliases              |

## Rules

- Pure contract tests run with default package Vitest config.
- Directive/integration tests must be named `*.integration.test.ts`.
- Run directive tests with `pnpm --filter @yolk-sdk/vercel-workflows test:workflow`.
- Assert observable workflow contract: stream chunks, replay/cancel behavior, terminal status.
- Use `waitForHook` + `resumeHook` for real `awaitInput` directive coverage.
- Do not assert Vercel SDK internals.
- The fake namespace's `evict` only drops the object: the old instance's pending code keeps running
  and may still write the shared storage (Cloudflare discards an evicted instance). Do not build
  tests on an old instance's late writes, such as an evicted index's decision landing after its
  restart; hold such code at a `makeGate` that is never opened instead.

## Anti-Patterns

- App auth/provider/tool imports in package tests.
- Effect runtime work inside package-owned `'use workflow'` orchestration bodies.
- Retrying streamed steps without event de-dupe semantics in the test scenario, or a model step
  re-execution that reuses event ids without an `executionId`.
