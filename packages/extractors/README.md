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

| Subpath                                       | Purpose                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/extractors`                        | Runtime-portable contract: `FileInput`, `ExtractedFile`, formats, errors, `fileFormatFor`, `defaultFileExtractorLimits`, `sanitizeExtractedText`, and the `FileExtractor` service tag. No parser imports.                                                                     |
| `@yolk-sdk/extractors/node`                   | `FileExtractorLayer` and `makeFileExtractorLayer(options)`: the Node implementation (unpdf, mammoth, SheetJS, fflate, `node:zlib`). Also `defaultWorkerIsolation`, the `FileExtractorIsolation` and `WorkerIsolationOptions` types, and `normalizeOfficeArchive` (see below). |
| `@yolk-sdk/extractors/node/extraction-worker` | The worker entry the Node layer starts per extraction (not imported directly; see Worker isolation).                                                                                                                                                                          |
| `@yolk-sdk/extractors/knowledge`              | `FileKnowledgeExtractorLayer`: a `@yolk-sdk/knowledge/extraction` `KnowledgeExtractor` backed by the `FileExtractor` in context, and `makeFileKnowledgeExtractor`.                                                                                                            |

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
The extractor copies the input before a parser reads it, so the caller's buffer is never
detached.

### Worker isolation

PDF, DOCX, XLSX, and PPTX files are parsed in a fresh Node `worker_threads` worker per
extraction. Only the extracted text and metadata come back. Text formats are decoded in the
calling thread; no parser reads them.

```ts
const FileExtractorLive = makeFileExtractorLayer({
  isolation: { maxOldGenerationSizeMb: 512, timeoutMs: 60_000 }
})
```

| `isolation` option         | Default                  | Bounds                                                                   |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `maxOldGenerationSizeMb`   | 256                      | V8 old-generation heap of each worker                                    |
| `maxYoungGenerationSizeMb` | 32                       | V8 young-generation heap of each worker                                  |
| `stackSizeMb`              | 4                        | Stack of each worker (Node's default)                                    |
| `timeoutMs`                | 30,000                   | Wall-clock time per worker (a real timer, not Effect's clock)            |
| `maxConcurrentWorkers`     | 4                        | This layer's share of the realm-wide pool of 4 workers (1 to 4)          |
| `maxQueueWaitMs`           | the layer's `timeoutMs`  | Time an extraction may wait for a worker slot; then it fails with `busy` |
| `workerUrl`                | the package's own worker | The worker entry, for hosts that bundle or relocate the package          |

**Cap per JavaScript realm.** Every layer in a JavaScript realm (the main thread, or each worker
thread that builds the layer) shares one pool of 4 workers, however often the layer is built (a
per-request `Effect.provide` builds a new one each time). The pool is kept on `globalThis`, so
duplicated copies of the package in that realm share it too. A host that runs its request
handlers in a pool of worker threads gets 4 workers per thread. A layer's
`maxConcurrentWorkers` can only lower its own share. Slots are handed out first come, first
served. An extraction waits for a slot at most `maxQueueWaitMs`, then fails with
`reason: 'busy'` without starting a worker; a slot freed after that deadline never admits it.

**What the worker bounds.** Each worker's V8 heap, stack, and running time. When a worker runs
out of heap, times out, cannot start, or exits without a result, it is terminated and the
extraction fails with `FileExtractionError` and `reason` set to `resource-limit`, `timeout`,
`worker-unavailable`, or `worker-failed`. A worker that cannot start never falls back to parsing
in-process. Four workers at the default heap add up to about 1 GB of V8 heap.

**What it does not bound.** Total process memory (RSS) and memory outside the V8 heap: Buffers,
inflated archive parts, and native allocations. Those are limited only by the 50 MiB input and
Office expanded-size limits, per running worker. PDF.js's decoded images, fonts, and streams have
no separate cap in this package, which is a residual risk for crafted PDFs. Your host's memory
limit (container or serverless function) is the outer bound: size it for four workers plus your
own load, or lower the limits.

Legitimate files at the default limits parse in well under a second, so 30 s only stops runaway
work.

`isolation: 'none'` parses in the calling thread, for runtimes without worker threads. It is
**unsafe for untrusted input**: a crafted file can then exhaust the process heap or block the
event loop. It is also the only mode that accepts a `loadSheetJs` function (tests use it to
observe SheetJS). A worker always imports the installed `xlsx` itself, so passing `loadSheetJs`
with worker isolation is a defect when the layer is built.

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
| `pptx`                            | Slide text in slide order, then speaker notes                                           | `title` = filename                       |

XLSX cells show their cached value as Excel displays it: SheetJS applies the number formats, and
format codes longer than Excel's own 255-character limit show as General. Formulas are not
parsed: a formula cell shows its cached result, and a formula cell without a cached value is
empty, never `=formula`. Excel, LibreOffice, and Google Sheets always store cached values; files
generated by code (openpyxl, ExcelJS, the SheetJS writer) may not. A worksheet is read when its
workbook relationship points at an `.xml` part; chart sheets and parts under another extension
are listed in `sheetNames` but have no rows. Comments, drawings, and other parts SheetJS does not
need for cell text are never parsed.

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
  is a deliberate tightening: OOXML input missing `[Content_Types].xml` or its main part
  (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`) now fails.
- **Worker isolation.** Every parser runs in a worker with V8 heap, stack, and time limits and a
  cap of 4 workers per JavaScript realm (see above). A parser path nobody has found yet that
  exhausts the worker's heap or runs too long ends in a typed error. Memory outside the V8 heap is
  bounded only by the input and expanded-size limits and your host's memory limit.
- **Generated SheetJS input.** SheetJS picks its parser from the archive, not the file name, and
  several of its XML parsers do work far beyond the size of the part. So SheetJS never receives
  the uploaded archive. The extractor builds a new one:
  - generated: `[Content_Types].xml`, `_rels/.rels`, and `xl/_rels/workbook.xml.rels`, so no
    attacker content type, part name, or relationship reaches SheetJS;
  - generated `xl/workbook.xml`: the sheets in order (name, `sheetId`, hidden state, a fresh
    relationship id each) and the 1904 date system, nothing else. SheetJS's defined-name handling
    is quadratic, and with shared relationship ids it parses one worksheet once per sheet. A
    workbook whose sheets the extractor and SheetJS's own tag grammar count or name differently,
    whose names repeat ignoring case, or whose sheets share a worksheet part is rejected;
  - generated `xl/styles.xml`: number formats (at most 255 characters after unescaping, at most
    1,000) and one cell format per source cell format, in order (at most 64,000). SheetJS
    re-parses a cell's format for every cell, so one huge format used by many cells would
    otherwise amplify;
  - copied: the worksheets (any `.xml` part related as a worksheet, stored as
    `xl/worksheets/sheet<n>.xml`) and `xl/sharedStrings.xml`, validated and hyperlink-stripped.
    Parts where SheetJS could meet a CDATA marker are rejected: SheetJS's unescaping recurses
    over an unterminated CDATA section with quadratic output, and Excel never writes CDATA there.
    SheetJS reaches that unescaping in two ways the check models. It decodes: up to two of
    `unescapexml` and `utf8read` (which keeps only each character's low byte, so `&#x13C;` in a
    `str` cell becomes `<` between its two decodes). And it removes tags before decoding: every
    `<si>` in the shared-strings table, and every `<r>` in rich text, so `A<<r>![CDATA[B` becomes
    `A<![CDATA[B`. Inline strings take the rich-text path even with `cellHTML: false`. So a part is
    rejected when its text, or its text after `utf8read`, contains `<<` or `<!`, or when its text,
    as is or with every simple opening tag removed, meets the marker after any chain of up to two
    conversions. This deliberately fails closed: XML comments, `<!DOCTYPE` and any other `<!…`
    declaration, and a literal `<<` in a worksheet or the shared strings are rejected as
    unsupported markup (CDATA, comments or declarations). Excel, LibreOffice, and Google Sheets
    never write them there. Some forms are rejected only because they fall in this superset, not
    because SheetJS 0.20.3 would expand them (for example `&lt;<r>![CDATA[`, which it decodes
    after its CDATA check).

  The title comes from `docProps/core.xml`, read by the extractor. With no marker entries and no
  `.bin` entries, SheetJS can only take its XLSX path. Everything else (comments, VML, drawings,
  `.bin` parts, external links, pivot caches, `customXml`, …) is left out.

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
  The renderer uses SheetJS's display text. SheetJS evaluates number formats inside `read`, before
  this budget, which is why it only ever reads the generated, bounded stylesheet.
- **SheetJS version.** Only SheetJS 0.20.3+ is used (see above). The prototype-pollution
  regression (CVE-2023-30533) is covered by a test with a crafted comment: the comment never
  reaches SheetJS, and SheetJS 0.20.3 parsing the file directly is not polluted either.

- **Residual risk.** SheetJS still parses the worksheets and shared strings as uploaded (after
  validation, the hyperlink strip, and the CDATA check, which models SheetJS 0.20.3's decodes and
  tag removals), and unpdf, mammoth, and the PPTX reader
  parse their parts. No other super-linear path is known in these parsers with the options used,
  but any one found later runs before the extractor's budgets. The worker's heap, stack, and time
  limits are the backstop for that, and they do not bound memory outside the V8 heap (PDF.js's
  decoded buffers included). With `isolation: 'none'` there is no backstop: a number format of up
  to 255 tokens still multiplies SheetJS's per-cell work and memory by up to about 255.

## Next.js

`@yolk-sdk/extractors/node` uses Node APIs and starts its worker from the package's
`dist/node/extraction-worker.mjs`: one self-contained file with Effect, fflate, mammoth, unpdf, and
the package's own code inlined. Its only other import is the optional `xlsx` peer, loaded
dynamically with its version check. Keep both packages unbundled in server code:

```ts
// next.config.ts
const nextConfig = {
  serverExternalPackages: ['@yolk-sdk/extractors', 'xlsx']
}
```

The default worker location is found from the package's own module (`dist/node/…` installed, or
`src/node/…` in a workspace that links the source, which needs the package built first). If a
bundler moves that module into a chunk of another name, there is no default: extraction fails
closed with `reason: 'worker-unavailable'` and starts nothing. Then copy
`@yolk-sdk/extractors/node/extraction-worker` somewhere with `xlsx` resolvable beside it and pass
its URL as `isolation.workerUrl`. With the package external, Next.js 16 (Turbopack) output file
tracing includes the worker. This was checked with an `output: 'standalone'` build that runs from
a copy of the traced files. If your tracer misses `dist/node/extraction-worker.mjs`, add it (and
`xlsx`) with `outputFileTracingIncludes`.

## Host responsibilities

- Upload size and auth policy, storage, and any per-user quotas.
- Choosing limits that fit your runtime's memory and the model context you feed the text to. The
  worker limits bound V8 heap and time, not the process: your platform's memory limit is the
  outer bound (see Worker isolation).
- Installing SheetJS from the CDN when XLSX extraction is needed.
