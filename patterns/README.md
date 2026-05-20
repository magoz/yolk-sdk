# Patterns

Architecture and convention patterns for the SDK workspace.

## Effect-TS

| Pattern                                                    | Purpose                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [EFFECT_BEST_PRACTICES.md](./EFFECT_BEST_PRACTICES.md)     | Type safety, Schema patterns, service/layer conventions                        |
| [EFFECT_TESTING.md](./EFFECT_TESTING.md)                   | Testing Effect programs, mocking services, property testing                    |
| [MCP_TRANSPORTS.md](./MCP_TRANSPORTS.md)                   | MCP JSON-RPC, stdio, HTTP, and Effect platform transport boundaries            |

## Packages

| Pattern                                                | Purpose                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| [PACKAGE_ARCHITECTURE.md](./PACKAGE_ARCHITECTURE.md)   | Agent/MCP/RAG package shape, boundaries, tree-shaking rules   |
| [PACKAGE_DISTRIBUTION.md](./PACKAGE_DISTRIBUTION.md)   | Package versioning, build, release, and artifact validation   |

## Observability

| Pattern                        | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| [TELEMETRY.md](./TELEMETRY.md) | Spans, error/warning reporting, retry ordering |

## Code Quality

| Pattern                                                      | Purpose                                              |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| [TYPESCRIPT_CONVENTIONS.md](./TYPESCRIPT_CONVENTIONS.md)     | Code style, file naming, type safety rules           |
| [TESTING_STRATEGY.md](./TESTING_STRATEGY.md)                 | Test philosophy, coverage targets, mock strategy     |

## Next example

Next/App Router-only patterns live in [`examples/next/patterns`](../examples/next/patterns/README.md).
