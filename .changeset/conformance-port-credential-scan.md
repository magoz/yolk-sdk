---
'@yolk-sdk/conformance': patch
---

`scanPortFixtureForSecrets` now flags credential query and form parameters inside every JSON string value, the note, and the failure message of a `PortFixture` (a signed URL a port answered, such as an S3 presigned URL's `X-Amz-Signature`, `X-Amz-Credential`, or `X-Amz-Security-Token`), and `redactPortPayload` / `isPortCredentialKey` (and the credential-field scan) also cover AWS-style `accessKeyId`, `secretAccessKey`, and `sessionToken` fields, camelCase or snake_case. Both fixture scans accept a credential parameter whose value starts with the new `syntheticCredentialMarker` (`yolk-synthetic`), reserved for documented synthetic placeholders; everything else stays flagged.
