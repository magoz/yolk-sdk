# Workflow Runtime Tests

Tests for Vercel Workflow orchestration contracts and package-owned directive fixtures.

## Files

| File | Role |
| --- | --- |
| `workflow-loop.test.ts` | Pure contract tests with fake step callbacks |
| `package-directives.integration.test.ts` | `@workflow/vitest` directive/start/stream/hook/cancel tests |
| `fixtures/workflow-fixture.ts` | Test-only workflow/step directive fixture; not published |

## Rules

- Pure contract tests run with default package Vitest config.
- Directive/integration tests must be named `*.integration.test.ts`.
- Run directive tests with `pnpm --filter @yolk-sdk/vercel-workflows-runtime test:workflow`.
- Assert observable workflow contract: stream chunks, replay/cancel behavior, terminal status.
- Use `waitForHook` + `resumeHook` for real `awaitInput` directive coverage.
- Do not assert Vercel SDK internals.

## Anti-Patterns

- App auth/provider/tool imports in package tests.
- Effect runtime work inside package-owned `'use workflow'` orchestration bodies.
- Retrying streamed steps without event de-dupe semantics in the test scenario.
