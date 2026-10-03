---
'@yolk-sdk/connectors': minor
---

Connector agent tools return JSON that matches their declared output. `makeConnectorToolRegistration` now Effect-encodes a successful action value with `Schema.toCodecJson(action.outputSchema)` before building the text content and `structuredContent`, so both match `ToolDef.outputSchema`: a `Chunk` becomes an array (instead of `{"_id":"Chunk","values":[...]}`), a `DateTime` an ISO string, and class instances plain objects. A value that does not encode fails the call with an `execution` `ToolError` with a value-free message. Provider failures keep their text, and their `structuredContent` is the JSON-encoded `ProviderFailure`; a non-JSON `underlying` (for example a wrapped error) is dropped. Unknown actions keep returning the value as is.

`makeConnectorToolModule` passes the connector's `description` as the `ToolModule.description` (shown by code mode under the namespace and indexed for tool search); the new `description` option overrides it.
