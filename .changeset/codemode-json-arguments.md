---
'@yolk-sdk/codemode': minor
---

Make code mode tool calls predictable for scripts.

- The pi executor (`makePiCodeModeExecutor`) rejects tool arguments that JSON would silently change, inside the script and before the call reaches the host (it never runs and is not recorded): non-finite numbers, `undefined`/function/symbol array items and holes, function/symbol/bigint values, cycles, and non-plain objects without `toJSON` (`Map`, `Set`, `RegExp`, `Error`, class instances). The `TypeError` names the tool and path, for example `tools.search: argument at limit is NaN; pass a finite number or omit the key` or `tools.search: argument at tags[1] is undefined; arrays cannot hold undefined`. `undefined`-valued keys stay allowed (absent), and `toJSON` values pass as their JSON (a `Date` becomes its ISO string). Script line numbers, `return`, `exit()`, `tools["raw.name"]`, and unknown-tool suggestions are unchanged; only line-1 columns shift.
- Breaking (0.x minor): nested calls that end in an error result or a `beforeNestedCall` failure now reject in the script with `tools.<identifier>: <message>` instead of the bare message. `ToolResult.nestedCalls` records keep the raw message.
- `CodeModeExecutorTool`/`CodeModeExecutor` document the JSON argument rules for custom executors, and the code mode description says arguments must be plain JSON and how rejections read.
