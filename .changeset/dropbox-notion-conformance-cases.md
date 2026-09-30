---
'@yolk-sdk/connectors': patch
---

Add the experimental `@yolk-sdk/connectors/dropbox/conformance` and `@yolk-sdk/connectors/notion/conformance` subpaths. Dropbox: eight cases (list folder and search cursor paging, case-insensitive path lookups with `path_lower`, the HTTP 409 `path/not_found` error envelope, folder create conflicts, delete then not-found, single-item copy/move metadata, and the upload rev precondition) with `DropboxConformanceConfig` seed paths and write cases that work only inside their own folder, registered by path before the create and always deleted again. Notion: eight cases (search, block children, and page property cursor paging, the `Notion-Version` requirement, the error envelope, title rich text, the 2025-09-03 database/data source split, and archiving a page to the trash) with `NotionConformanceConfig` seed ids and a self-cleaning write case. Both ship synthetic replay fixtures; no case is observed live yet.
