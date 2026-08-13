# E2E Tests

Playwright tests with Effect-based setup/teardown and a separate `.env.test` database.

See `examples/next/patterns/E2E_TESTING.md` for detailed locator, isolation, seeding,
streaming, redirect, and gotcha guidance.

## Local Rules

- Import `{ test, expect }` from `../fixtures` for authenticated specs; use `@playwright/test` for public specs.
- Never mutate user-level state on `TEST_USER_ID`; create a dedicated user for user-level mutations.
- Domain data on `TEST_USER_ID` uses unique deterministic names/IDs per file.
- `process.env.TEST_SESSION_TOKEN` is an approved Playwright setup → fixture handoff boundary only.
- Never add direct `dotenv.config()`; import centralized `examples/next/lib/dotenv` from Playwright boundaries.
- Route-stub nondeterministic external streams only when asserting UI/request encoding or streamed UI projection.

## Files

| Path                     | Role                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `playwright.config.ts`   | App-local runner; loads `.env.test`; starts fixed-port app server |
| `e2e/global-setup.ts`    | Reset DB, seed test user, create signed session                   |
| `e2e/global-teardown.ts` | TRUNCATE CASCADE cleanup                                          |
| `e2e/fixtures.ts`        | `authedContext`, `authedPage`, `apiContext`                       |
| `e2e/test-ids.ts`        | Deterministic IDs shared by setup/specs                           |
| `e2e/utils/*`            | Test DB/auth/session/context helpers                              |
| `e2e/ui/*`               | Browser specs                                                     |
| `e2e/assets/*`           | Checked-in audio fixtures                                         |

## Voice E2E

- `e2e/ui/agent-voice.spec.ts` mocks Realtime SDP/WebRTC; keep assertions below live provider behavior.
- `e2e/ui/agent-voice-live.spec.ts` is live OpenAI Realtime coverage, skips without `OPENAI_API_KEY`, and uses `e2e/assets/voice-alpha-beta-gamma-delayed.wav`.

## Commands

- Run all E2E: `pnpm test:e2e`
- UI/debug: `pnpm test:e2e:ui`, `pnpm test:e2e:debug`
- Override port: `E2E_PORT=41774 pnpm test:e2e`

## Anti-Patterns

- Worker-scoped authenticated browser state.
- Positional selectors (`first`, `nth`, CSS) when accessible names can be fixed.
- `waitForTimeout`, manual visibility checks, or hard reload loops.
- Generated `playwright-report/**` or `test-results/**` as source/docs.
