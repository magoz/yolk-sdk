# Docs map

Map changed code to docs that must be inspected or updated.

## Repo-wide docs

| Change | Docs |
| --- | --- |
| workspace/package list | `README.md`, root `AGENTS.md`, `apps/docs/content/docs/reference/packages.mdx` |
| docs IA/philosophy | `apps/docs/AGENTS.md`, `apps/docs/content/docs/meta.json` |
| package release/versioning policy | `apps/docs/content/docs/migration.mdx`, `patterns/PACKAGE_DISTRIBUTION.md` |
| recurring failure | `apps/docs/content/docs/troubleshooting.mdx` |

## Agent package

| Change | Docs |
| --- | --- |
| protocol events/messages/tools | `agent/protocol.mdx`, `reference/protocol.mdx`, `api-reference/agent.mdx` |
| loop/runtime behavior | `agent/loop-runtime.mdx`, `guides/build-chat-route.mdx`, `guides/persist-session.mdx`, `guides/durable-session-store.mdx` |
| tools/HITL | `agent/tools-hitl.mdx`, `guides/add-tool.mdx`, `guides/hitl.mdx`, `troubleshooting.mdx` |
| client transport | `agent/client-react.mdx`, `guides/stream-react.mdx`, `vercel-workflows/routes.mdx` |
| React helpers | `guides/react-chat-ui.mdx`, `agent/client-react.mdx`, `api-reference/agent.mdx` |
| providers/OAuth | `integrations/model-providers.mdx`, `integrations/provider-setup.mdx`, `agent/providers-oauth.mdx` |
| testing helpers | `guides/testing.mdx`, `api-reference/agent.mdx` |

## MCP package

| Change | Docs |
| --- | --- |
| remote client/list/call | `mcp/index.mdx`, `integrations/mcp-tools.mdx`, `mcp/auth-local-server.mdx` |
| local stdio | `mcp/auth-local-server.mdx`, `troubleshooting.mdx` |
| server APIs | `mcp/auth-local-server.mdx`, `api-reference/integrations.mdx` |
| tool/result mapping | `integrations/mcp-tools.mdx`, `mcp/index.mdx` |

## Knowledge package

| Change | Docs |
| --- | --- |
| documents/availability | `knowledge/index.mdx`, `reference/host-responsibilities.mdx` |
| ingestion pipeline | `knowledge/ingestion-pipeline.mdx`, `integrations/knowledge-search.mdx` |
| search behavior | `integrations/knowledge-search.mdx`, `knowledge/ingestion-pipeline.mdx` |
| agent tool | `integrations/knowledge-search.mdx`, `api-reference/integrations.mdx` |

## Connectors package

| Change | Docs |
| --- | --- |
| new connector | `integrations/index.mdx`, `integrations/connectors.mdx`, `connectors/index.mdx`, `api-reference/integrations.mdx` |
| action id/schema | `integrations/connectors.mdx`, `integrations/connector-tool.mdx` |
| credential slot/config key | `integrations/connectors.mdx`, `connectors/index.mdx`, `troubleshooting.mdx` |
| agent adapter | `integrations/connector-tool.mdx`, `api-reference/integrations.mdx` |

## Sandbox package

| Change | Docs |
| --- | --- |
| core command/result/lifecycle | `sandbox/index.mdx`, `sandbox/lifecycle-safety.mdx`, `troubleshooting.mdx` |
| Vercel adapter config | `integrations/sandbox.mdx`, `sandbox/lifecycle-safety.mdx` |
| agent sandbox tool | `sandbox/index.mdx`, `integrations/sandbox.mdx`, `api-reference/integrations.mdx` |
| testing fakes | `guides/testing.mdx`, `api-reference/integrations.mdx` |

## Vercel Workflows package

| Change | Docs |
| --- | --- |
| loop config/callbacks | `vercel-workflows/index.mdx`, `vercel-workflows/step-contracts.mdx`, `api-reference/workflows.mdx` |
| routes/headers/continuation | `vercel-workflows/routes.mdx`, `agent/client-react.mdx`, `troubleshooting.mdx` |
| HITL hooks/resume | `vercel-workflows/hitl-resume.mdx`, `guides/hitl.mdx` |
| durable events/terminal barrier | `vercel-workflows/step-contracts.mdx`, `vercel-workflows/index.mdx` |
| tests/directives | `vercel-workflows/testing.mdx` |

## Docs app code

| Change | Docs |
| --- | --- |
| Fumadocs config/source | `apps/docs/AGENTS.md`, `llms.txt` expectations |
| route/layout/search | `apps/docs/AGENTS.md` if process changes |
| `llms.txt` exports | `index.mdx`, `apps/docs/AGENTS.md`, validation with `pnpm build:docs` |
