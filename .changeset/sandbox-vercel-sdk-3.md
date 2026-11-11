---
'@yolk-sdk/sandbox': patch
---

Use `@vercel/sandbox` 3.9.1 (was 2.2.1). The Vercel adapter's calls are unchanged; `persistent` is
still passed explicitly, so 3.x's persistent-by-default does not apply.
