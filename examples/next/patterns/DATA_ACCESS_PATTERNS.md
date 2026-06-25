# Data Access Patterns

How data crosses Next app boundaries. This file is the decision map; detailed Effect pipe
ordering lives in the linked boundary patterns.

## Decision Map

| Need | Use | Canonical pattern |
| --- | --- | --- |
| Initial page read | Server Component + `NextEffect.runPromise` | `EFFECT_PAGES.md` |
| Auth/session-gated page | Suspense shell + async `Content` | `EFFECT_PAGES.md` |
| Create/update/delete | Server action in `examples/next/lib/core/[domain]/*-action.ts` | `EFFECT_SERVER_ACTIONS.md` |
| Domain read/write logic | App-owned Effect function in `examples/next/lib/core/*` | `EFFECT_DOMAIN_FUNCTIONS.md` |
| Browser upload | Server action creates R2 presigned PUT URL; browser uploads direct; action finalizes | Storage/knowledge core docs |
| External webhook/HTTP boundary | API route under `examples/next/app/api/*` | `EFFECT_API_ROUTES.md` |
| Shareable filters/page state | Route-local `search-params.ts` with `nuqs/server` | `NUQS_URL_STATE.md` |

## Rules

- Reads default to RSC/page programs; do not add API routes for normal page reads.
- Mutations default to server actions; regular browser CRUD does not belong in API routes.
- Keep request/UI concerns (`redirect`, `notFound`, `revalidatePath`, `reportError`, toast) out of domain functions.
- Server actions return typed success/error objects unless they redirect.
- After successful mutations, revalidate at the action boundary; avoid `router.refresh()` as the primary reconciliation path.
- Keep server-rendered lists as source of truth; use `useOptimistic` only for small local deltas.
- File uploads use signed direct upload flows; do not proxy bytes through app routes.

## Where To Look

| Area | Current examples |
| --- | --- |
| Knowledge records/files | `examples/next/lib/core/knowledge/*`, `examples/next/app/knowledge/*` |
| Storage source ingestion | `examples/next/app/storage/*` |
| Upload/object storage service | `examples/next/lib/services/knowledge/*` |
| Search/index services | `examples/next/lib/services/knowledge-search/*` |
| API route boundaries | `examples/next/app/api/AGENTS.md` |

## Anti-Patterns

- `examples/next/app/api` for browser CRUD.
- Client-only collection state replacing server-rendered data just for optimistic UI.
- Domain functions importing Next navigation/cache APIs.
- Raw `fetch()` to app API routes from first-party UI when a server action exists.
- Example-only auth, DB, storage, or UI policy leaking into `packages/*`.
