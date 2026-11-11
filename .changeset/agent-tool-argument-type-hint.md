---
'@yolk-sdk/agent': patch
---

A tool argument validation error now names a number or boolean the model sent as a JSON string, with the literal to send instead.

Effect's issue text said only `Expected number | null at ["offset"]`. A model that quoted its numbers (seen in production on a DeepSeek model, inside a tool whose parameters are a union of operations) read that as a broken system and gave up paginating. `withToolArgumentsErrorHint`, used by the default `makeTool` message and by callbacks that append it, now adds one line per such argument, for example `Argument "offset" must be a JSON number, but it was the string "120": send 120 without quotes.` A string whose contents are not a value the schema takes (`"abc"`, or `"5"` where only 1 to 3 are allowed) is named without a literal, and long strings are not quoted. No line is added for a string the schema could take on the wire (a `String` member, a string-encoded codec) or that another union member accepted; where the schema also takes string literals, only a quoted number or boolean is named. The hint covers argument errors from every `makeTool` tool, interaction and input calls, and the loop's `question` decode; validation itself is unchanged.
