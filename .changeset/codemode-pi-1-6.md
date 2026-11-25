---
'@yolk-sdk/codemode': minor
---

Upgrade `@earendil-works/pi-codemode` from 1.0.0 to 1.6.0 (the Node executor's engine, and the prelude the Dynamic Worker executor vendors). Scripts behave the same except:

- Built-ins are frozen and built-in globals are read-only before the script runs, on both executors, so a script cannot patch them (`Array.prototype.toJSON = ...` has no effect; `defineProperty` on a built-in throws). Subclasses can still set `name`, `message` and the other commonly overridden members on their own instances.
- A script fails with a `RangeError` (`script` error) once it has printed 16 Mi characters or 100,000 `text()`, `image()` and `console.*` items, instead of growing the host's memory until the timeout.
- A script spinning on promise jobs (`while (true) await null`) is stopped at the timeout like a synchronous loop. `image()` errors describe the accepted block as `{ type: "image", data, mimeType }` instead of an MCP image block.
- `console.*` prints `NaN` and `Infinity` as `text()` does, instead of `null`. A thrown error's `name` and `message` are reported as strings, and a thrown value that cannot be described fails the script with `The script threw a value that cannot be described`.
- Tool declarations in the code mode description, `describeTool` and `describeNamespace` show schema constraints TypeScript cannot express as comment tags on the property (`// @integer @minimum 0 @default 10`), which puts such objects on several lines. Descriptions of tools with such constraints are longer, so fewer of them fit `inlineBudget` and their text changes once. A local `$ref` with a malformed percent escape now renders as `unknown` instead of failing the whole catalog.

`makePiCodeModeExecutor` keeps an execution's concurrency slot until its worker has exited: pi 1.3 settles a result once it has asked the worker to stop. Output items keep the `CodeModeOutputItem` shape (pi's `console: true` marker is dropped).
