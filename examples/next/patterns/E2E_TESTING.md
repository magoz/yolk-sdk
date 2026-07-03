# E2E Testing

Next example Playwright conventions. Tests use `.env.test`, a separate database, and
Effect-based setup/teardown.

## Locator Priority

Test what users see and do, not implementation details.

| Priority | Locator            | Use                                                        |
| -------- | ------------------ | ---------------------------------------------------------- |
| 1        | `getByRole`        | Buttons, links, headings, rows, menuitems; pass `{ name }` |
| 2        | `getByLabel`       | Inputs, textareas, comboboxes, switches                    |
| 3        | `getByPlaceholder` | Only when adding a label is not practical                  |
| 4        | `getByText`        | Non-interactive elements only                              |
| 5        | `getByTestId`      | Last resort                                                |

Never use CSS selectors for user flows. When two controls share a locator, fix the app with a
unique accessible name instead of using positional selectors.

## Web-First Assertions

- Always `await expect(locator).toBeVisible()` / `toHaveCount()` / `toHaveText()`.
- Never use `waitForTimeout`.
- Avoid `expect(await locator.isVisible()).toBe(true)`; it skips auto-waiting.
- Use `{ timeout: 10_000 }` or similar for streaming sections.

## Isolation

- Tests across files run in parallel; each test must be independent.
- Auth fixtures are test-scoped and inject the shared signed session cookie.
- Use unique names/IDs per spec file for domain data.
- For mutating tests, seed one record per test.
- For user-level state mutations, create a dedicated user in `beforeAll`.
- With shared seeded data, use `test.describe.configure({ mode: 'serial' })`.
- Cleanup first in `beforeAll`; Playwright retries rerun `beforeAll`.

## Env + App Startup

1. `pnpm test:e2e*` delegates to `@yolk-example/next`.
2. `examples/next/playwright.config.ts` loads only `.env.test` via `examples/next/lib/dotenv`.
3. The app starts on fixed `E2E_PORT`/default `41773`; portless is intentionally not used.
4. `global-setup.ts` resets DB, creates deterministic test user/session, and sets `TEST_SESSION_TOKEN`.
5. `fixtures.ts` creates test-scoped authenticated contexts.
6. `global-teardown.ts` truncates test DB tables.

Required bootstrap env: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_POSTHOG_KEY`.

better-auth test session cookies use HMAC-SHA256 with standard base64 (not base64url), then
URL encoding. Cookie name is `better-auth.session_token` for HTTP and
`__Secure-better-auth.session_token` for HTTPS.

## Effect Boundaries

- Keep DB/auth setup inside Effect at Playwright edges only.
- Use `ensureTestEnv()` before destructive operations.
- `Effect.runPromise` is allowed in `globalSetup`, `globalTeardown`, and `beforeAll`.
- Reusable helpers return `Effect` values; do not run them internally.
- `process.env.TEST_SESSION_TOKEN` is an approved setup → fixture handoff boundary only.

## Streaming + Suspense

- Suspense hydration can briefly duplicate DOM elements.
- Before interacting with streamed controls, assert a single match: `await expect(locator).toHaveCount(1)`.
- Redirects inside Suspense may happen after `page.goto()` resolves; race `waitForURL` against expected content.
- Prefer function predicates for redirects: `page.waitForURL(url => url.toString().includes('/login'))`.

## Accessibility Labels

Every form control needs an accessible name.

Preferred label sources:

1. `<label htmlFor>` — visible, clickable, programmatically associated.
2. `aria-labelledby` — use existing visible text.
3. `aria-label` — invisible; use only when visual context is clear.
4. Placeholder alone — never sufficient.

## Direct WebSocket Specs

Cloudflare direct-WS specs may use Node-side `WebSocket` with `Effect.callback` helpers.
Keep protocol encode/decode typed with `@yolk-sdk/agent/protocol` schemas, use fresh UUID
sessions, and use the unbootstrapped faux-provider path for deterministic persistence/conflict/fallback checks.

## Adding a Spec

1. Create `examples/next/e2e/ui/my-feature.spec.ts`; create `e2e/api/` first for API specs.
2. Import fixtures correctly: authenticated from `../fixtures`, public from `@playwright/test`.
3. Add `test.describe.configure({ mode: 'serial' })` when using shared `beforeAll` data.
4. Start `beforeAll` with cleanup for all deterministic IDs.
5. Use unique names/IDs per spec to avoid parallel-worker collisions.
6. Add deterministic IDs to `test-ids.ts`; ensure no ID is a substring of another.
7. Use exact names on filter/toggle buttons to avoid substring matches.
8. Add `toHaveCount(1)` guards before interacting with streamed controls.

## Multi-User Tests

- Use `createAuthedContext(browser, token)` from `e2e/utils/create-authed-context.ts`.
- Close per-user pages/contexts at the end of the test.
- Prefer `expect.soft()` when one multi-user scenario verifies several independent facts.

## Gotchas

- `fullyParallel: true` splits describe blocks across workers; serial mode prevents duplicate setup.
- `getByRole('heading')` may match multiple levels; pass `{ level }` or `{ name }`.
- Regex filters like `/saved/i` can match `Unsaved`; prefer exact names.
- Deterministic IDs must not be substrings of each other because URL/text includes checks can collide.
- Cold dev server plus parallel workers can cause timeouts; local retries are enabled.
- `playwright-report/**` and `test-results/**` are generated; never treat them as source/docs.
