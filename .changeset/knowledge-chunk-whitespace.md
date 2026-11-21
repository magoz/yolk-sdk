---
'@yolk-sdk/knowledge': patch
---

The default chunker keeps the whitespace between the pieces of a sentence (or word) longer than `maxTokens` and the text that follows it. It trimmed each piece and then joined pieces that fit one chunk as they were, so words and sentences ran together ("sixseven", "fourteen.Then"). Chunks of text without such sentences are unchanged; re-chunking a document that had them gives correctly spaced chunks, and may move a boundary because each piece's token count now includes its trailing space.
