# Next Example Patterns

Patterns specific to the private Next.js dogfood/reference app.

| Pattern | Purpose |
| --- | --- |
| [DATA_ACCESS_PATTERNS.md](./DATA_ACCESS_PATTERNS.md) | RSC for reads, server actions for mutations, S3 signed URLs |
| [EFFECT_API_ROUTES.md](./EFFECT_API_ROUTES.md) | HttpEffect API routes, request schemas, response/error handling |
| [EFFECT_PAGES.md](./EFFECT_PAGES.md) | Suspense + Content, streaming sections, filter-driven selective loading |
| [EFFECT_SERVER_ACTIONS.md](./EFFECT_SERVER_ACTIONS.md) | Server action structure, pipe ordering, error handling |
| [NUQS_URL_STATE.md](./NUQS_URL_STATE.md) | nuqs import rules, search-params.ts pattern, pagination |
| [USABILITY_BEST_PRACTICES.md](./USABILITY_BEST_PRACTICES.md) | Navigation, auth pages, empty states, loading states |

Keep root `patterns/` for repo-wide SDK/package patterns. Keep app-only routing, rendering, auth, and URL-state rules here.
