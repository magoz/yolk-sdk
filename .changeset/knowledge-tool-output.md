---
'@yolk-sdk/knowledge': minor
---

`makeKnowledgeLookupTool` and `makeKnowledgeManageTool` declare output schemas (`KnowledgeLookupOutput`, `KnowledgeManageOutput`, exported from `@yolk-sdk/knowledge/agent`) and return their JSON encoding as `structuredContent`, so code mode scripts get structured values: `{ operation: 'search', results: Array<{ document, score?, context? }> }`, `{ operation: 'get', document }` (document dates as ISO strings), and `{ operation, document: { id, slug, title } }`. The text content is unchanged. A handler value that does not encode fails the call with an `execution` `ToolError`.
