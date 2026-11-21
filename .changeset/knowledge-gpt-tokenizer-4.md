---
'@yolk-sdk/knowledge': patch
---

`@yolk-sdk/knowledge` depends on `gpt-tokenizer` `^4.1.2` (was `^3.4.0`), so a host on 4.x dedupes to one copy and its bundler emits the `o200k_base` tokenizer (about 1 MB gzipped) once instead of twice. The default chunker's `o200k_base` calls are unchanged, and chunk boundaries and token counts stay the same except for text containing U+FEFF or U+0085, which `gpt-tokenizer` 4.x now tokenizes like tiktoken.
