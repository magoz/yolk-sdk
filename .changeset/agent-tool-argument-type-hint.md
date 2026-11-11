---
'@yolk-sdk/agent': patch
---

A tool argument validation error now names a number or boolean the model sent as a JSON string, with the literal to send instead.

Effect's issue text said only `Expected number | null at ["offset"]`. A model that quoted its numbers (seen in production on a DeepSeek model, inside a tool whose parameters are a union of operations) read that as a broken system and gave up paginating. `withToolArgumentsErrorHint`, used by the default `makeTool` message and by callbacks that append it, now adds one line per such argument, for example `Argument "offset" must be a JSON number, but it was the string "120": send 120 without quotes.` A non-numeric string is named without a literal, and long strings are not quoted. The hint covers errors from `decodeToolArguments` (every `makeTool` tool, interaction and input calls); validation itself is unchanged.
