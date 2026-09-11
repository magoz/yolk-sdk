---
'@yolk-sdk/agent': minor
'@yolk-sdk/connectors': minor
'@yolk-sdk/knowledge': minor
'@yolk-sdk/mcp': minor
'@yolk-sdk/sandbox': minor
'@yolk-sdk/vercel-workflows': minor
---

Add a host-only Dropbox original-byte download helper, `downloadDropboxFile`, on `@yolk-sdk/connectors/dropbox` for parity with the OneDrive helper. It reuses the existing `dropbox.oauth` binding through a new `files.content.read` scope and `DropboxContentReadOAuthCredentialSlot` (now also included in `DropboxCombinedOAuthCredentialSlot`), calls the Dropbox content endpoint once through the optional bounded binary HTTP port, never follows redirects, returns allowlisted `Dropbox-API-Result` metadata plus untouched bytes, and sanitizes failures to typed codes. Default Dropbox actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.
