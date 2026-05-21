# @yolk-sdk/agent/protocol

Domain-free agent protocol types and helpers.

## What it provides

- Agent transcript message schemas.
- Streamed agent event schemas.
- Tool definition/call/result schemas.
- HITL approval/question request and response schemas.
- Text/image/audio content helpers.
- Model capability and reasoning config types.

## Use it when

- Building providers, loops, clients, or transports that need the shared Yolk agent wire model.
- Converting app state into protocol messages before an agent run.
- Rendering or storing provider-produced agent events.

## Boundaries

- No provider SDKs.
- No app auth, storage, routes, or product concepts.
- No transport assumptions.
