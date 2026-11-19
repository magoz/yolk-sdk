---
'@yolk-sdk/codemode': minor
---

Add `@yolk-sdk/codemode/cloudflare`: `makeDynamicWorkerCodeModeExecutor({ loader, compatibilityDate? })` runs code mode scripts on Cloudflare Workers, each in a fresh Dynamic Worker isolate (a Worker Loader binding, `WorkerLoader`) without network access. Scripts get the same globals, tools guard, and tool rejection codes as `makePiCodeModeExecutor`; tool and global calls return to the calling Worker over RPC, TypeScript is stripped with Sucrase (a new dependency), and the timeout and abort signal end the execution from the caller. The tools guard now lives in one module both executors share; pi's in-VM prelude is vendored (MIT) with a test that fails when the installed `@earendil-works/pi-codemode` copy differs.
