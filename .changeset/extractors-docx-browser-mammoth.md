---
'@yolk-sdk/extractors': patch
---

Extract `.docx` text where mammoth's browser build is resolved, such as Cloudflare Workers under Vite. Its browser unzip reads only `arrayBuffer`, so every DOCX failed there with "Could not extract DOCX text" (cause "Could not find file in options"). The extractor now gives mammoth the stored archive as both `buffer` (Node) and `arrayBuffer` (browser).
