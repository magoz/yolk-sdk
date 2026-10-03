# @yolk-sdk/extractors

Bounded text extraction for PDF, DOCX, XLSX, PPTX, CSV, JSON, Markdown, and plain-text files: an
Effect `FileExtractor` service with Office archive validation, hyperlink-safe XLSX text, and a
`KnowledgeExtractor` adapter for `@yolk-sdk/knowledge`.

## Install

```bash
pnpm add @yolk-sdk/extractors@canary effect@4.0.0-rc.115
# Only if you extract .xlsx files: SheetJS from the SheetJS CDN, not npm.
pnpm add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0-rc.115`) in host code.
Requires Node.js 22+. `@yolk-sdk/extractors/node` is server-only.

### Why SheetJS comes from its CDN

SheetJS (`xlsx`) is an optional peer dependency (`>=0.20.3`), loaded with a dynamic import only
when an XLSX file is extracted. The `xlsx` package on npm is unmaintained at 0.18.5, which has
CVE-2023-30533 (prototype pollution from a crafted file, fixed in 0.19.3) and CVE-2024-22363
(regular-expression denial of service, fixed in 0.20.2). Fixed releases are published only as
tarballs on `cdn.sheetjs.com`. A published package must not depend on a URL, so the host installs
the tarball itself.

pnpm records the tarball URL and its integrity hash in the lockfile. A direct tarball dependency
needs no extra pnpm 11 settings. `blockExoticSubdeps` (default `true`) rejects tarball and git
dependencies only below the top level. `minimumReleaseAge` (default one day) checks registry
publish times, and a URL tarball has none. Because the peer is optional, SheetJS cannot arrive
transitively: each host adds it directly.

If SheetJS is missing, is not a SheetJS build, or is older than 0.20.3 (for example a leftover npm
`xlsx@0.18.5`, or a 0.20.3 prerelease), XLSX extraction fails with `SheetJsUnavailableError`
(`reason: 'missing' | 'invalid' | 'outdated'`). A `version` that is not strict SemVer counts as
`invalid`. Its message includes the install command. Other formats never load SheetJS.

## Subpaths

| Subpath                          | Purpose                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/extractors`           | Runtime-portable contract: `FileInput`, `ExtractedFile`, formats, errors, `fileFormatFor`, `defaultFileExtractorLimits`, `sanitizeExtractedText`, and the `FileExtractor` service tag. No parser imports. |
| `@yolk-sdk/extractors/node`      | `FileExtractorLayer` and `makeFileExtractorLayer(options)`: the Node implementation (unpdf, mammoth, SheetJS, fflate, `node:zlib`). Also `normalizeOfficeArchive` (see below).                            |
| `@yolk-sdk/extractors/knowledge` | `FileKnowledgeExtractorLayer`: a `@yolk-sdk/knowledge/extraction` `KnowledgeExtractor` backed by the `FileExtractor` in context, and `makeFileKnowledgeExtractor`.                                        |

## Example

```ts
import { Effect } from 'effect'
import { FileExtractor } from '@yolk-sdk/extractors'
import { makeFileExtractorLayer } from '@yolk-sdk/extractors/node'

const FileExtractorLive = makeFileExtractorLayer({ limits: { maxInputBytes: 10 * 1024 * 1024 } })

const program = Effect.gen(function* () {
  const extractor = yield* FileExtractor

  return yield* extractor.extract({ filename: 'report.xlsx', mediaType: '', bytes })
}).pipe(Effect.provide(FileExtractorLive))
```

`bytes` is a host-owned `Uint8Array`. `FileExtractorLayer` is the same layer with default limits.
The extractor copies PDF input before PDF.js reads it, so the caller's buffer is never detached.

Knowledge ingestion:

```ts
import { Layer } from 'effect'
import { FileKnowledgeExtractorLayer } from '@yolk-sdk/extractors/knowledge'
import { FileExtractorLayer } from '@yolk-sdk/extractors/node'

const KnowledgeExtractorLive = FileKnowledgeExtractorLayer.pipe(Layer.provide(FileExtractorLayer))
```

The adapter passes string `content` through unchanged (blank text fails). Bytes are extracted with
the format chosen from the source's name (`File` name or ref, `Url` path, `Text` label) and media
type (`LoadedKnowledgeSource.mediaType`, then the `File` source's, then `text/plain` for `Text`
sources). The extracted title becomes the document title. `format`, `pageCount`, and `sheetNames`
merge under the source's own metadata, so host keys win. Failures become
`KnowledgeExtractionError` with the original error as `cause`.

## Output

| Format                            | Text                                                                                    | Metadata                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| `text`, `markdown`, `csv`, `json` | UTF-8 decoded                                                                           | `title` = filename                       |
| `pdf`                             | Text of all pages (unpdf)                                                               | PDF `Title` if set, `pageCount`          |
| `docx`                            | Raw text (mammoth)                                                                      | `title` = filename                       |
| `xlsx`                            | One `# <sheet>` section per sheet with bounded CSV rows; external links as `text <url>` | workbook title or filename, `sheetNames` |

XLSX cells show their cached value as Excel displays it (number formats applied by SheetJS).
Formulas are not parsed: a formula cell shows its cached result, and a formula cell without a
cached value is empty, never `=formula`. Excel, LibreOffice, and Google Sheets always store cached
values; files generated by code (openpyxl, ExcelJS, the SheetJS writer) may not. Only worksheets
whose workbook relationship points at `xl/worksheets/<name>.xml` are read; chart sheets and
worksheet parts stored elsewhere or under another extension are skipped. Comments, drawings, and
other parts SheetJS does not need for cell text are never parsed.
| `pptx` | Slide text in slide order, then speaker notes | `title` = filename |

All text is sanitized: line endings are normalized, control characters dropped, and runs of
spaces, dots, and blank lines collapsed. Empty results fail with `FileExtractionError`. The format
comes from the filename extension first, then the media type, then any `text/*` media type as
plain text. Everything else fails with `UnsupportedFileFormatError`.

## Limits

`defaultFileExtractorLimits` (the values the 10x app runs in production); override any of them
through `makeFileExtractorLayer({ limits })`. Invalid values are a defect when the layer is built.

| Limit                   | Default | Bounds                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------- |
| `maxInputBytes`         | 50 MiB  | Input size, every format                                                  |
| `maxArchiveEntries`     | 10,000  | ZIP entries in DOCX, XLSX, PPTX                                           |
| `maxExpandedBytes`      | 50 MiB  | Inflated bytes of an Office archive, counted while inflating              |
| `maxXlsxSheets`         | 100     | Worksheets                                                                |
| `maxXlsxCellVisits`     | 100,000 | Cells inside every sheet's declared range, absent cells included          |
| `maxXlsxTextCharacters` | 512 Ki  | XLSX text, annotations and the omission marker included; at least 62      |
| `maxXlsxHyperlinks`     | 10,000  | Hyperlinks read per workbook. Extra links are dropped but still stripped. |

Exceeding a limit fails the extraction with `FileExtractionError`. The exceptions are hyperlink
annotations and links beyond the cap, described below.

## Security model

- **Office archives** (DOCX, XLSX, PPTX) are validated before any parser sees them. The ZIP
  directory is read only as an index and its sizes are never trusted. Each entry is inflated in
  bounded chunks, and the real output is counted against its declared size and
  `maxExpandedBytes`. Encrypted, ZIP64, split, and duplicate-name archives fail (names that differ
  only in case count as duplicates, as in OPC), as do archives with ambiguous paths (`..`, `.`,
  `//`, absolute, backslashes, control characters) or macro projects (`vbaProject.bin`). Directory
  entries ending in `/` are fine. Parsers then get archives rebuilt from the validated bytes. This
  is a
  deliberate tightening: OOXML input missing `[Content_Types].xml` or its main part
  (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`) now fails.
- **Allowlisted SheetJS input.** SheetJS picks its parser from the archive, not the file name,
  and its ODS, Numbers, and binary (XLSB) parsers expand ranges per cell from parts the XML
  hyperlink strip never sees. So SheetJS never receives the uploaded archive. The extractor builds
  a new one containing only validated, hyperlink-stripped parts under canonical names:
  `xl/workbook.xml`, the worksheets its relationships point at (only `xl/worksheets/*.xml`, stored
  as `xl/worksheets/sheet<n>.xml`), `xl/sharedStrings.xml`, `xl/styles.xml`, and
  `docProps/core.xml` (for the title), plus `[Content_Types].xml`, `_rels/.rels`, and
  `xl/_rels/workbook.xml.rels` generated by the extractor, so no attacker content type, part name,
  or relationship reaches SheetJS. With no marker entries and no `.bin` entries, SheetJS can only
  take its XLSX path. Everything else (comments, VML, drawings, `.bin` parts, external links, pivot
  caches, `customXml`, …) is left out.
- **Early rejection.** For a clear error instead of "Could not read XLSX", XLSX input that SheetJS
  would route elsewhere fails before SheetJS loads: ODS and Numbers marker entries
  (`META-INF/manifest.xml`, `objectdata.xml`, `Index/Document.iwa`, `Index.zip`, any `Root Entry/`
  name), matched after SheetJS's own path normalisation (first `//` collapsed, `Root Entry/`
  stripped, `\` as `/`, any case); XLSB content types in `[Content_Types].xml` overrides; and
  relationship targets or override part names ending in `.bin`, unless they are types SheetJS
  never parses (printer settings, OLE and ActiveX binaries, custom properties, attached toolbars).
  Tags and attributes are read exactly as SheetJS reads them (quoted values may contain `<`;
  attribute names are case-sensitive). `.bin` elsewhere in a name (`data.bin.xml`, an
  `archive.bin/` directory, `Id="rId.bin"`) is fine.
- **Formulas off.** SheetJS runs with `cellFormula: false` (and without HTML, styles, stubs, or
  VBA), so shared formulas are never copied onto every dependent cell and array formulas are never
  rescanned per cell. Only cached values are read (see Output).
- **`normalizeOfficeArchive`** returns a validated, rebuilt archive of every part for storage or
  for other parsers. It applies the same archive checks and, for XLSX, the hyperlink strip and the
  early rejections, but it keeps parts SheetJS must never see (printer settings, comments, …).
  Never run SheetJS on its output directly: extract XLSX text through `FileExtractor`, which builds
  the allowlisted input.
- **XLSX hyperlinks.** Before parsing, SheetJS (0.18.5 and 0.20.3) expands every
  `<hyperlink ref>` range into per-cell objects. A 6 KB file with `ref="A1:XFD1048576"`
  exhausts a 1 GB heap. So the extractor reads each `<hyperlink>` itself (`ref`, `r:id` to the
  worksheet relationship target, `location`, `display`), up to `maxXlsxHyperlinks` per workbook. It
  removes every hyperlink tag from every archive part, replacing each with a space so fragments
  cannot join into a new tag. SheetJS never sees one. In the text, every existing cell of the
  visited range that falls inside a link is written as `text <url>`. An indexed lookup over the
  visited range keeps this at O((links + cells) · log) instead of a scan of every link per cell.
  Only `http:`, `https:`, and `mailto:` targets are shown (normalized; links whose target is
  longer than 2,048 characters are dropped). `display` labels are cut to 1,024 characters ending
  in `…`, and an annotation that cannot fit the remaining budget is rejected by its length before
  it is built. Internal `#Sheet!A1` locations and other schemes are omitted. Plain text is
  rendered first and links use only the budget left over. When an annotation does not fit, or
  links exceed the cap, the cell is written plain and the output ends with one
  `[Some hyperlinks omitted: output limit]` (or `hyperlink limit`) marker, inside the budget.
- **UTF-16 parts.** SheetJS decodes BOM-marked UTF-16 parts itself, and the byte-level strip
  cannot see tags inside them. Any XLSX part whose stripped bytes would decode as UTF-16 with a
  hyperlink tag is rejected. Excel never writes UTF-16 parts.
- **Bounded XLSX text.** Every sheet range is checked strictly against Excel's grid, and the
  cell-visit total is checked before any cell is read. CSV is generated incrementally against
  the character budget (never `sheet_to_csv`). Cells and sheets are read as own properties only.
  The CSV renderer uses parser-provided display text and does not re-evaluate number-format
  templates.
- **SheetJS version.** Only SheetJS 0.20.3+ is used (see above). The prototype-pollution
  regression (CVE-2023-30533) is covered by a test with a crafted comment: the comment never
  reaches SheetJS, and SheetJS 0.20.3 parsing the file directly is not polluted either.

## Next.js

`@yolk-sdk/extractors/node` uses Node APIs and a dynamic `import('xlsx')`. In a Next.js host, use
it from server code only. If the host does not install SheetJS, add `@yolk-sdk/extractors` to
`serverExternalPackages`, so the bundler does not try to resolve the optional `xlsx` import at
build time.

## Host responsibilities

- Upload size and auth policy, storage, and any per-user quotas.
- Choosing limits that fit your runtime's memory and the model context you feed the text to.
- Installing SheetJS from the CDN when XLSX extraction is needed.
