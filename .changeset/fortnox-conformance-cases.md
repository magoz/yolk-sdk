---
'@yolk-sdk/connectors': patch
---

Add experimental connector conformance subpaths. `@yolk-sdk/connectors/conformance` bridges an Effect `HttpClient` to `ConnectorHttpClient` and `ConnectorBinaryHttpClient` and adds `staticCredentialResolverLayer`, for conformance and tests only (no streamed byte limits, redirect, or DNS policy; not a production adapter). `@yolk-sdk/connectors/fortnox/conformance` adds seven Fortnox conformance cases (invoice list decoding, preview PDF, payment filters excluding unbooked invoices, sticky row discounts, empty strings not clearing customer fields, rejected-write `ErrorInformation`, and a manual-only invoice email send) with `FortnoxConformanceConfig` seed identities, exact restore-and-verify for the row and customer mutation cases, an absence check before the rejection case writes, a recipient check before the email case sends, and synthetic replay fixtures.
