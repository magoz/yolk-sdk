# E2E Tests

Playwright tests with Effect-based setup/teardown and a separate `.env.test` database.

See `examples/next/patterns/E2E_TESTING.md` for detailed locator, isolation, seeding,
streaming, redirect, and gotcha guidance.

## Rules

- Import `{ test, expect }` from `../fixtures` for authenticated specs; use `@playwright/test` for public specs.
- Test user-visible behavior with role/label/text locators; never assert CSS classes or DOM internals.
- Use web-first `await expect(...)`; never use `waitForTimeout`.
- Authenticated fixtures are test-scoped; never switch them to worker scope unless state leakage is intentional.
- Never mutate user-level state on `TEST_USER_ID`; create a dedicated user for user-level mutations.
- Domain data on `TEST_USER_ID` must use unique deterministic names/IDs per file.
- Add `test.describe.configure({ mode: 'serial' })` when `beforeAll` seeds shared deterministic data.
- Start `beforeAll` with cleanup; retries rerun setup.
- Use `toHaveCount(1)` before interacting with streamed/hydrating form controls.
- Add deterministic IDs to `test-ids.ts`; ensure no ID is a substring of another.
- E2E uses fixed HTTP port `E2E_PORT`/default `41773`; do not reintroduce portless.
- `process.env.TEST_SESSION_TOKEN` is an approved Playwright setup → fixture handoff boundary only.
- Route-stub nondeterministic external streams only when asserting UI/request encoding or streamed UI projection.

## Effect Boundaries

- Keep DB/auth setup inside Effect; run it only at Playwright edges (`globalSetup`, `globalTeardown`, `beforeAll`).
- Use `ensureTestEnv()` before destructive operations.
- `Effect.runPromise` is acceptable in Playwright hooks only; reusable helpers return `Effect` values.
- Never add direct `dotenv.config()`; import centralized `examples/next/lib/dotenv` from Playwright boundaries.

## Files

| Path | Role |
| --- | --- |
| `playwright.config.ts` | App-local runner; loads `.env.test`; starts fixed-port app server |
| `e2e/global-setup.ts` | Reset DB, seed test user, create signed session |
| `e2e/global-teardown.ts` | TRUNCATE CASCADE cleanup |
| `e2e/fixtures.ts` | `authedContext`, `authedPage`, `apiContext` |
| `e2e/test-ids.ts` | Deterministic IDs shared by setup/specs |
| `e2e/utils/*` | Test DB/auth/session/context helpers |
| `e2e/ui/*` | Browser specs |
| `e2e/assets/*` | Checked-in audio fixtures |

## Commands

- Run all E2E: `pnpm test:e2e`
- UI/debug: `pnpm test:e2e:ui`, `pnpm test:e2e:debug`
- Override port: `E2E_PORT=41774 pnpm test:e2e`

## Anti-Patterns

- Worker-scoped authenticated browser state.
- Positional selectors (`first`, `nth`, CSS) when accessible names can be fixed.
- `waitForTimeout`, manual visibility checks, or hard reload loops.
- Generated `playwright-report/**` or `test-results/**` as source/docs.
