---
'@yolk-sdk/agent': patch
---

Advertise `Schema.optional(X)` tool params to Claude (compatibility mode) as `X` instead of an unconstrained `{}`: drop the `{ type: 'null' }` member of a non-required property's `anyOf`/`oneOf` (argument decoding reads that `null` as "not sent") before flattening. Root union properties required in one variant and optional in another now merge to their type. Required, array-item, and `Schema.optional(Schema.NullOr(X))` nulls stay widened as before.
