---
'@yolk-sdk/agent': minor
---

Add general-purpose action-backed interactions: `makeInteractionTool` registers call/response Effect schemas, an app renderer key, explicit access, and server-defined named actions with optional side-effect-free validation and execute handlers. Distinct `InteractionRequest`/`InteractionResponse` flow through the existing HITL protocol, transport, runtime, and headless React projection with requested/accepted/executing/completed/failed/unknown states; submitted interactions never synthesize a tool result. Selected actions execute behind `ToolExecutor` with an explicit interaction reference admitted through the mandatory host receipt port (`read`/`claim`/`settle` over host-owned storage). Built-in payload-free cancellation, JSON-preserving validation, replay of settled receipts, and fail-closed voice/background/unsupported handling included.
