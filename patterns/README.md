# Patterns

Architecture and convention patterns for this codebase.

## Effect-TS

| Pattern                                                    | Purpose                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [EFFECT_BEST_PRACTICES.md](./EFFECT_BEST_PRACTICES.md)     | Type safety, Schema patterns, service/layer conventions                        |
| [EFFECT_DOMAIN_FUNCTIONS.md](./EFFECT_DOMAIN_FUNCTIONS.md) | Data queries, service composition, error definitions                           |
| [EFFECT_SERVER_ACTIONS.md](./EFFECT_SERVER_ACTIONS.md)     | Server action structure, pipe ordering, error handling                         |
| [EFFECT_PAGES.md](./EFFECT_PAGES.md)                       | Suspense + Content, streaming sections, filter-driven selective loading (nuqs) |
| [EFFECT_API_ROUTES.md](./EFFECT_API_ROUTES.md)             | HttpEffect API routes, request schemas, response/error handling                |
| [EFFECT_TESTING.md](./EFFECT_TESTING.md)                   | Testing Effect programs, mocking services, property testing                    |

## Data Flow

| Pattern                                              | Purpose                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| [DATA_ACCESS_PATTERNS.md](./DATA_ACCESS_PATTERNS.md) | RSC for reads, server actions for mutations, S3 signed URLs |

## URL State

| Pattern                                  | Purpose                                                 |
| ---------------------------------------- | ------------------------------------------------------- |
| [NUQS_URL_STATE.md](./NUQS_URL_STATE.md) | nuqs import rules, search-params.ts pattern, pagination |

## Observability

| Pattern                        | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| [TELEMETRY.md](./TELEMETRY.md) | Spans, error/warning reporting, retry ordering |

## Code Quality

| Pattern                                                      | Purpose                                              |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| [TYPESCRIPT_CONVENTIONS.md](./TYPESCRIPT_CONVENTIONS.md)     | Code style, file naming, type safety rules           |
| [TESTING_STRATEGY.md](./TESTING_STRATEGY.md)                 | Test philosophy, coverage targets, mock strategy     |
| [USABILITY_BEST_PRACTICES.md](./USABILITY_BEST_PRACTICES.md) | Navigation, auth pages, empty states, loading states |
