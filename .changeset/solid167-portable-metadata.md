---
'@yolk-sdk/connectors': minor
---

`ConnectorIntegration` and `CredentialBinding` `metadata` is now `PortableMetadata`. Decode and `make` return a **snapshot copy** (null-prototype objects, new dense arrays; DAG aliases share snapshot nodes; input identity is not kept; snapshots are not frozen).

Admitted data: own enumerable data keys (including `__proto__` / `constructor`), unknown extension keys, JSON `null` values, booleans, strings, finite numbers, nested plain/`null`-prototype objects, and dense arrays. Omitted metadata is absent.

Rejected at every depth (no silent Date/Map/class→`{}`): root `null`/arrays/primitives, inherited or class prototypes, `Date`, `Map`, functions, `undefined` values, nonfinite numbers, cycles, sparse arrays, hidden/symbol keys, and accessor payload fields (getters are not invoked). `decodeUnknownEffect` fails with `SchemaError`; synchronous constructors/factories throw `Error` with a `SchemaIssue` cause. Proxy reflection traps are not covered by a general immunity claim.

Integration `config` stays `Record<string, unknown>`. Credential secrets stay `credentialRef` + host `CredentialResolver`. Error `underlying` stays `unknown`. Hosts loading untrusted JSON should decode `PortableMetadata` (or the parent class).
