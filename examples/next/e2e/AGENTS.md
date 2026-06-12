# E2E Tests

Playwright tests with Effect-based setup/teardown. Uses `.env.test` with a separate test database. Prefer real app services; route-stub nondeterministic external streams only when asserting UI/request encoding or streamed UI projection.

## Playwright Best Practices

From the [official Playwright best practices](https://playwright.dev/docs/best-practices) and [locators guide](https://playwright.dev/docs/locators).

### Test user-visible behavior

Test what users see and do, not implementation details. Never assert on CSS classes, internal state, or DOM structure that users don't interact with.

### Locator priority (strict)

| Priority  | Locator              | When to use                                                                                    |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| 1         | `getByRole`          | Buttons, links, headings, rows, menuitems, checkboxes. Always pass `{ name }` for specificity. |
| 2         | `getByLabel`         | Form controls with `<label>` or `aria-label` (inputs, textareas, comboboxes, switches).        |
| 3         | `getByPlaceholder`   | Form elements without labels. Prefer adding `<label>` or `aria-label` so `getByLabel` works.   |
| 4         | `getByText`          | Non-interactive elements only (div, span, p). **Never** for buttons/links/inputs.              |
| 5         | `getByTestId`        | Last resort when no user-facing attribute works.                                               |
| **NEVER** | `page.locator()` CSS | Tied to DOM structure, breaks on redesigns.                                                    |

```ts
// 1. getByRole — best for interactive elements
page.getByRole('button', { name: 'Create Post' })
page.getByRole('link', { name: 'Settings' })
page.getByRole('heading', { name: 'Dashboard' })

// 2. getByLabel — best for form controls (works with <label> and aria-label)
page.getByLabel('Title')
page.getByLabel('Email')

// BAD — never use these
page.locator('.font-semibold')
page.locator('[data-slot="input"]')
```

### Narrow scope with chaining and filtering (not `.first()`/`.nth()`)

Use `.filter({ hasText })` or `.filter({ has })` to uniquely identify elements. Avoid `.first()`/`.nth()`/`.last()` — they break when page content changes.

```ts
// good — filter by unique content
const row = page.getByRole('row').filter({ hasText: 'My Post' })

// acceptable — when same text genuinely appears in multiple sections
page.getByRole('link', { name: /My Post/ }).first()

// bad — positional, fragile
page.getByRole('row').nth(2)
```

When two elements share the same locator and filtering can't distinguish them, **fix the app** by adding a unique `aria-label` rather than using positional selectors.

### Web-first assertions (always `await expect`)

Playwright auto-waits for conditions to be met. Never use manual checks.

```ts
// good — auto-waits for condition
await expect(page.getByText('Posts')).toBeVisible()

// bad — no auto-wait, flaky
expect(await page.getByText('Posts').isVisible()).toBe(true)

// bad — hardcoded waits
await page.waitForTimeout(2000)
await page.reload()
```

### Never use `waitForTimeout`

Replace `waitForTimeout` + `reload` with web-first assertions that auto-retry:

```ts
// bad
await page.waitForTimeout(1000)
await page.reload()
await expect(page.getByText('Published')).toBeVisible()

// good — auto-waits for the DOM to update
await expect(page.getByText('Published')).toBeVisible({ timeout: 10_000 })
```

### Test isolation

Each test must be completely independent. No test should depend on another test's side effects. Tests across files run in **parallel** (separate workers). Tests within a `describe` block with `{ mode: 'serial' }` share a worker.

Authenticated fixtures are **test-scoped**: each test gets a fresh `BrowserContext` with the shared signed session cookie injected. Never switch these to worker scope unless the test suite explicitly accepts state leakage.

#### User-level state needs a dedicated user

**NEVER mutate user-level state** (role, etc.) **on `TEST_USER_ID`**. Other files running in parallel share this user. If a test needs to change user-level state, create a **dedicated user** in `beforeAll`:

```ts
const MY_USER_ID = 'e2e-my-feature-user-001'

test.beforeAll(async () => {
  await Effect.gen(function* () {
    // ... create user + session
  }).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)
})
```

#### Domain data uses unique names

`TEST_USER_ID` is fine for domain data (posts, etc.) as long as each file uses **unique names/IDs** for seeded data. This prevents text collisions across parallel files.

#### One record per mutating test

For tests that modify data (delete, update), seed a **separate record per test** with a distinct name.

## Architecture

```
examples/next/playwright.config.ts — app-local runner config
examples/next/e2e/
  global-setup.ts                 — reset DB + seed user + create auth session
  global-teardown.ts              — TRUNCATE CASCADE cleanup
  test-ids.ts                     — deterministic IDs shared between setup and specs
  fixtures.ts                     — authedContext/authedPage (session cookie injection) + apiContext
  utils/
    test-db.ts                    — TestDbLayer alias for test infra
    cleanup.ts                    — schema-aware TRUNCATE all tables CASCADE
    create-test-auth-session.ts   — session row + HMAC-SHA256 signed cookie
    create-authed-context.ts      — BrowserContext with session cookie for multi-user tests
    ensure-test-env.ts            — Effect.die guard for NODE_ENV=test
    create-test-user.ts           — inserts user with random email
    auth-cookie.ts                — better-auth cookie signing helpers
    setup.ts                      — Effect setup helper
  assets/                         — checked-in audio fixtures
  ui/
    login.spec.ts                 — Public smoke tests
    knowledge.spec.ts             — Authenticated knowledge management smoke
    agent-image.spec.ts           — Authenticated image upload + capability UI; stubs /api/agent stream
    agent-workflow-task.spec.ts   — Workflow task/subagent UI smoke
    agent-voice.spec.ts           — Deterministic mocked WebRTC voice readiness smoke
    agent-voice-live.spec.ts      — Live fake-mic Realtime transcription smoke; skips without OPENAI_API_KEY
    agent-cloudflare.spec.ts      — Direct Worker WS reconnect/persistence/conflict/fallback smoke; skips without CLOUDFLARE_AGENT_URL
```

## Env Isolation

E2E scripts set `NODE_ENV=test`, so `examples/next/playwright.config.ts` loads **only** `.env.test` via centralized `examples/next/lib/dotenv.ts`; otherwise the app loads `.env.local` + `.env`.

**Never add a direct `dotenv.config()` call** — always import `examples/next/lib/dotenv` from Playwright boundaries. This is the single source of truth.

`examples/next/playwright.config.ts` fails fast if bootstrap env is missing: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_POSTHOG_KEY`. Route-specific app env can still be required by pages under test.

## How It Works

1. `pnpm test:e2e*` delegates to `@yolk-example/next`; app-local Playwright config loads `.env.test`, starts `@yolk-example/next` on fixed HTTP port `E2E_PORT`/default `41773`; E2E intentionally does not use portless because Playwright webServer teardown can orphan proxy-launched `next dev`
2. `global-setup.ts` runs:
   - Resets database via `drizzle-seed` (truncate + reseed)
   - Creates test user with deterministic ID from `test-ids.ts`
   - Creates better-auth session with HMAC-SHA256 signed cookie
   - Shares signed session token via `process.env.TEST_SESSION_TOKEN`
3. `fixtures.ts` provides test-scoped `authedContext`/`authedPage` and `apiContext` with JSON accept header; cookie domain/secure derive from Playwright `baseURL`
4. Each test gets an isolated authenticated page ready to navigate
5. `global-teardown.ts` runs TRUNCATE CASCADE after all tests

`process.env.TEST_SESSION_TOKEN` is an approved Playwright setup → fixture handoff boundary; do not copy this pattern into app/services.

## Key Patterns

### Auth cookie signing (better-auth)

better-auth uses HMAC-SHA256 with **standard base64** (NOT base64url), then URL-encoded:

```ts
import { createHmac } from 'crypto'

const signature = createHmac('sha256', secret).update(value).digest('base64')
return encodeURIComponent(`${value}.${signature}`)
```

Cookie name: `better-auth.session_token` for HTTP and `__Secure-better-auth.session_token` for HTTPS; fixture domain and `secure` flag derive from Playwright `baseURL`.

### Effect at Playwright boundaries

Keep DB/auth setup inside Effect; run it only at Playwright edges (`globalSetup`, `globalTeardown`, `beforeAll`). Use `ensureTestEnv()` before destructive operations.

```ts
await Effect.gen(function* () {
  yield* ensureTestEnv('Seed My Feature')
  const db = yield* Db
  // cleanup + seed
}).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)
```

`Effect.runPromise` is acceptable here because Playwright hooks are the async boundary. Do not use it inside reusable helpers; helpers should return `Effect` values.

Root Vitest currently may discover package tests; `pnpm test:run` then also runs `packages/*` tests. If scripts/config change, update root/package docs together.

### Direct WebSocket specs

Cloudflare direct-WS E2E may use Node-side `WebSocket` with `Effect.callback` helpers because browser WS APIs are imperative. Keep protocol encode/decode typed with `@yolk-sdk/agent/protocol` schemas; use fresh UUID sessions and the unbootstrapped faux-provider path for deterministic persistence/conflict/fallback checks.

### Per-file data seeding

Each spec file that needs specific data should create it in `test.beforeAll`:

```ts
test.describe('My feature', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    await Effect.gen(function* () {
      const db = yield* Db
      // Cleanup first (retries re-run beforeAll)
      yield* db.delete(schema.post).where(eq(schema.post.id, MY_POST_ID))
      // Then seed
      yield* db.insert(schema.post).values({ id: MY_POST_ID, ... })
    }).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)
  })
})
```

### Serial mode for shared seeded data

When multiple tests share seeded data, use serial mode to prevent `beforeAll` running in multiple workers:

```ts
test.describe.configure({ mode: 'serial' })
```

### Streaming duplicate guard (`toHaveCount(1)`)

Suspense hydration can briefly duplicate DOM elements. Interacting with a ghost element causes silent failures. Before interacting with elements on streamed pages:

```ts
// Wait for streaming to settle
await expect(page.getByLabel('Title')).toHaveCount(1, { timeout: 15_000 })

// Now safe to interact
await page.getByLabel('Title').fill('New Title')
```

Every form input needs an accessible name. `getByLabel` (priority 2) is preferred over `getByPlaceholder` (priority 3) — good for both a11y and test stability.

**Labeling hierarchy** (W3C WAI, pick the highest that fits):

1. **`<label htmlFor>`** — visible, clickable, programmatically associated. Gold standard.
2. **`aria-labelledby`** — references a visible element by `id`. Prefer when the visual label already exists but `<label>` doesn't fit.
3. **`aria-label`** — invisible to sighted users. Use when control's purpose is clear from visual context alone.
4. **`placeholder` alone** — never sufficient for accessibility. Always add one of the above.

Playwright's `getByLabel` matches both `<label>` and `aria-label`, so all three approaches give stable test locators. When adding a new input, add the label in the same PR.

### Redirect inside Suspense boundary

Next.js streaming sends the Suspense fallback first. `NextEffect.redirect()` inside a Content component streams as a client-side redirect AFTER `page.goto()` resolves. Use a race pattern:

```ts
const redirected = page
  .waitForURL(url => url.toString().includes('/login'), { timeout: 15_000 })
  .then(() => true)
const contentLoaded = page
  .getByRole('heading', { name: 'Dashboard' })
  .waitFor({ timeout: 15_000 })
  .then(() => false)

const wasRedirected = await Promise.race([redirected, contentLoaded])
expect(wasRedirected).toBe(true)
```

### Multi-user tests

Create per-user sessions and build `BrowserContext` per test:

```ts
import { createAuthedContext } from '../utils/create-authed-context'

test('member cannot delete', async ({ browser }) => {
  const context = await createAuthedContext(browser, memberToken)
  const page = await context.newPage()
  // ... assertions ...
  await page.close()
  await context.close()
})
```

### Soft assertions for multi-check tests

Use `expect.soft()` when verifying multiple things:

```ts
await expect.soft(page.getByText('Posts')).toBeVisible()
await expect.soft(page.getByText('Settings')).toBeVisible()
```

## Adding a New Spec

1. Create `examples/next/e2e/ui/my-feature.spec.ts`; create `examples/next/e2e/api/` first if adding API specs
2. Import `{ test, expect }` from `../fixtures` (authenticated) or `@playwright/test` (public)
3. Add `test.describe.configure({ mode: 'serial' })` if using `beforeAll`
4. **Start `beforeAll` with cleanup** for all deterministic IDs — retries re-run `beforeAll`
5. Use unique names/IDs per spec to avoid collisions with parallel workers
6. Add any new deterministic IDs to `test-ids.ts` — **ensure no ID is a substring of another**
7. Use `{ name: '...', exact: true }` on filter/toggle buttons to avoid substring matches
8. For streamed pages, add `toHaveCount(1)` guards before interacting

## Gotchas

- **ESLint false-flags Playwright's `use` callback** — `react-hooks/rules-of-hooks` thinks it's a React hook. `fixtures.ts` has `/* eslint-disable */`.
- **`fullyParallel: true` splits describe blocks across workers** — `beforeAll` runs once per worker, not once per describe. Use `test.describe.configure({ mode: 'serial' })` when `beforeAll` creates data with deterministic IDs.
- **Streaming sections need timeouts** — Suspense sections load independently. Each assertion needs `{ timeout: 10_000 }` or similar.
- **Serial `beforeAll` re-runs on retry** — Playwright retries re-run `beforeAll`, causing unique constraint errors. Delete before re-creating at the top of `beforeAll`.
- **`waitForURL` glob vs function predicate** — `waitForURL('**/login**')` waits for `load` event. Use function predicate `waitForURL(url => url.toString().includes('/login'))` — resolves on navigation match, not just `load`.
- **Streaming ghost clicks** — clicking a button during hydration can target a DOM element about to be detached. The click appears to succeed but has no effect. Fix: `toHaveCount(1)` before clicking.
- **Port conflicts** — E2E uses fixed HTTP port `E2E_PORT`/default `41773`. Override with `E2E_PORT=... pnpm test:e2e`.
- **No portless for E2E** — do not reintroduce portless here; it can hang Playwright teardown and leave orphan `next dev` processes.
- **`getByRole('heading')` matches multiple levels** — use `{ level: 1 }` or `{ name: '...' }` to disambiguate h1 from h2.
- **`process.env` propagation** — `globalSetup` shares env vars with workers. Deterministic IDs in `test-ids.ts` are more reliable than env vars.
- **Test IDs must not be substrings of each other** — e.g. `e2e-project-foo` is a prefix of `e2e-project-foobar`, breaking `url.includes()` checks. Use distinct stems.
- **Full suite flaky under cold start** — parallel workers hitting a cold Next.js dev server can cause timeouts. Config is `retries: 1` local, `retries: 2` CI.
- **Filter buttons with similar names** — `/saved/i` regex matches both "Saved" and "Unsaved". Use `{ name: 'Saved', exact: true }`.
- **Generated Playwright artifacts** — `playwright-report/**` and `test-results/**` are ESLint-ignored; do not put source/docs there.
