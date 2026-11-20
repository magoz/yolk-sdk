---
'@yolk-sdk/knowledge': minor
---

`@yolk-sdk/knowledge/chunking` (and `./ingestion`) no longer evaluate `gpt-tokenizer` (about 2 MB of rank tables) on import. The default chunker loads it with a dynamic `import()` the first time text is chunked or counted, once per process or isolate; importing `KnowledgeChunker` or building `DefaultKnowledgeChunkerLive` stays cheap, and bundlers keep the tokenizer in a separate chunk.

Breaking: `countKnowledgeChunkTokens(text)` returns `Effect<number, KnowledgeChunkingError>` instead of `number` (`yield* countKnowledgeChunkTokens(text)`). `chunkKnowledgeText` and the default chunker may fail with `KnowledgeChunkingError` (`Failed to load the default tokenizer`) when the tokenizer cannot load; invalid `maxTokens` and empty content still fail before it loads.
