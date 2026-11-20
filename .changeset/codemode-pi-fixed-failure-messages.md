---
'@yolk-sdk/codemode': minor
---

`makePiCodeModeExecutor` (`@yolk-sdk/codemode/node`) now answers its own failures with fixed messages, as the Dynamic Worker executor does, so runtime error text never reaches the model: `Could not create the sandbox.` (before: `Could not create the sandbox: <error>`), and `The script sandbox failed.` for pi's `sandbox` failures (before: pi's text, such as `Failed to load QuickJS: <error>` or a worker crash). `onInternalError` receives the original error (`load` and `isolate`). Script errors, timeouts, and aborts are unchanged.
