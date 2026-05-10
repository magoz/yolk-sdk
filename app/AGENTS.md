# App Router

Next.js App Router UI and route composition. Keep app-specific wiring here; move only stable, domain-free agent pieces to `packages/*`.

## Structure

| Area          | Role                                     |
| ------------- | ---------------------------------------- |
| `page.tsx`    | Public home page                         |
| `(auth)/`     | Login, OTP, logout, auth error UI        |
| `agent/`      | Text + voice agent playground UI         |
| `api/`        | HTTP boundaries; see `app/api/AGENTS.md` |
| `globals.css` | Tailwind 4 globals/theme                 |

## Page Rules

- Default to Server Components; add `'use client'` only for browser state/effects/events.
- Data/session-gated pages use Suspense shell + async `Content` component.
- Run Effect page programs with `NextEffect.runPromise()`, not `Effect.runPromise()`.
- Protected/session-gated pages must be dynamic: `export const dynamic = 'force-dynamic'` or dynamic APIs like `cookies()`.
- Re-fail `NextEffect.isNavigationError(error)` before catch-all fallbacks.
- Shareable filters/search state belongs in `search-params.ts` with `nuqs/server` imports.

## Auth UI

- Auth pages live under `(auth)/`; better-auth handler lives in `app/api/auth/[...all]/route.ts`.
- Login/OTP pages redirect authenticated users via `NextEffect.redirect('/')`.
- Logout uses `window.location.href = '/'`; do not replace with `router.push()` because cached layouts can stay stale.
- Keep auth form controls accessible; E2E relies on labels/roles.

## Agent UI

- `/agent` is the unified text + mic page; `/agent/voice` is legacy redirect only.
- See `app/agent/AGENTS.md` before touching chat state/rendering.
- Console/status/debug chrome stays out of core conversation layout.

## Anti-Patterns

- CRUD mutations in `app/api` — use server actions in `lib/core/[domain]/*-action.ts`.
- Direct data fetch in page body — use Suspense + `Content` pattern.
- Client component by default — isolate browser-only state to leaf components.
- `Effect.runPromise()` in pages — use `NextEffect.runPromise()`.
