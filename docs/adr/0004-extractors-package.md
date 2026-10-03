# Extractors package

Status: accepted.

Five apps carry their own copy of one file extractor (`lib/services/file-extractor`, API
`extract(FileInput) → ExtractedFile` for PDF, DOCX, XLSX, PPTX, and text): yolk `examples/next`,
speldosa, 10x, taus (identical to 10x), and LMK. The copies have drifted. 10x and LMK added
Office archive validation and bounded XLSX text, taus added a UTF-16 guard, and the yolk and
speldosa copies have none of it. All of them pin npm `xlsx@0.18.5`. Move the hardened extractor
into a public package, `@yolk-sdk/extractors`, that the apps consume.

## Decision summary

| Area       | Decision                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Package    | New public package `@yolk-sdk/extractors`, lockstep with the other packages.                                                  |
| Subpaths   | Root: portable contract and service tag. `./node`: the implementation. `./knowledge`: `KnowledgeExtractor` adapter.           |
| SheetJS    | Optional peer `xlsx >=0.20.3`, lazily imported, version-checked at runtime. Hosts install the SheetJS CDN tarball.            |
| Archives   | Every DOCX, XLSX, and PPTX goes through bounded ZIP validation and is rebuilt as a stored archive before any parser reads it. |
| SheetJS    | SheetJS only reads an archive the extractor builds (workbook and styles generated); XLSB/ODS/Numbers input is rejected early. |
| Isolation  | Every PDF, DOCX, XLSX, and PPTX parse runs in a fresh worker thread with heap, stack, and time limits; failures are typed.    |
| Formulas   | SheetJS runs with `cellFormula: false`: cached values only, formula-only cells are empty.                                     |
| Hyperlinks | Read and removed before SheetJS parses; external targets shown as `text <url>` through an indexed lookup.                     |
| UTF-16     | XLSX parts whose stripped bytes decode as BOM-marked UTF-16 with a hyperlink tag are rejected.                                |
| Limits     | The 10x defaults, configurable per layer.                                                                                     |

## Why a package

The copies are security boundaries for untrusted uploads, and each fix so far landed in one or two
apps: archive validation in 10x, the hyperlink strip in LMK, the UTF-16 guard in taus. Fixes
already arrive late or not at all. One package with one test suite lets every app get the next
fix by upgrading. The extractor is domain-free (bytes in, text out), so it fits the package rules.
Hosts keep upload policy, auth, storage, and what the text is used for.

## Subpaths and dependency direction

- `@yolk-sdk/extractors` (root): `FileInput`, `ExtractedFile`, formats, the `Schema.TaggedError`
  errors, `fileFormatFor`, `defaultFileExtractorLimits`, `sanitizeExtractedText`, and the
  `FileExtractor` `Context.Service` tag. It imports no parsers and no Node builtins, so other
  runtimes can provide their own implementation.
- `@yolk-sdk/extractors/node`: `FileExtractorLayer` and `makeFileExtractorLayer({ limits,
isolation, loadSheetJs })`. It covers PDF (`unpdf`), DOCX (`mammoth`), XLSX (SheetJS), and PPTX and archive
  validation (`fflate`, `node:zlib`, `node:stream`). It also exports `normalizeOfficeArchive` for
  hosts that validate Office bytes outside extraction, as 10x does for email attachments. Its
  output is a validated, rebuilt archive for storage or other parsers, never SheetJS input.
- `@yolk-sdk/extractors/knowledge`: `FileKnowledgeExtractorLayer`, which provides
  `@yolk-sdk/knowledge/extraction`'s `KnowledgeExtractor` from the `FileExtractor` in context.
  String content passes through, and bytes are extracted using the source name and media type.
  Because the tag lives in the root, the adapter stays portable and is tested with a fake layer.
- Direction: `extractors/knowledge → @yolk-sdk/knowledge`. Knowledge never imports extractors.
  `@yolk-sdk/knowledge` is a normal `workspace:^` dependency, following the current dependency
  policy. An optional peer would avoid installing knowledge and agent for hosts that skip
  `./knowledge`, but Changesets bumps peer dependents aggressively. The boundary script enforces
  the direction and the Node-only rule.

## SheetJS: optional peer from the CDN

npm `xlsx` stops at 0.18.5, which has:

- CVE-2023-30533: prototype pollution while reading a crafted file, fixed in 0.19.3. Comments were
  inserted with `sheet[ref]`, so `ref="__proto__"` set `Object.prototype.c`.
- CVE-2024-22363: ReDoS, fixed in 0.20.2.

Current SheetJS (0.20.3) ships only as `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. A
published package must not depend on a URL, so `xlsx` is an optional peer (`>=0.20.3`,
`peerDependenciesMeta.xlsx.optional`). Hosts that extract XLSX run
`pnpm add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.

`./node` loads SheetJS only when an XLSX file arrives, through an injectable loader (default
`() => import('xlsx')`). It then checks the module: `read` must be a function and `version` must
be strict SemVer and at least 0.20.3 by SemVer precedence (a 0.20.3 prerelease is below it;
anything that is not strict SemVer is `invalid`). A missing, foreign, or outdated module fails with `SheetJsUnavailableError`
(`missing | invalid | outdated`), whose message carries the install command. A host that ignores
peer warnings therefore cannot silently run 0.18.5. Tests swap SheetJS through the loader instead
of mocking modules. A function cannot be passed to a worker, so `loadSheetJs` only works with
`isolation: 'none'`; the worker always imports the installed `xlsx` with the same check.

In the workspace, the package (dev dependency) and `examples/next` install the CDN tarball. Under
pnpm 11 defaults, a direct tarball dependency needs no settings changes. `blockExoticSubdeps`
(default `true`) only rejects exotic dependencies below the top level. `minimumReleaseAge`
(default one day) reads registry publish times, and a URL tarball has none. The lockfile pins the
tarball's `sha512` integrity, which was checked against a fresh download.

## Office archives

From 10x: the ZIP central directory is read only as a bounded index, and its sizes are never
trusted for allocation. Each entry is inflated in 1 KiB input chunks with 16 KiB output slices.
The real output is counted against the entry's declared size and `maxExpandedBytes` (50 MiB). The
validator rejects:

- encrypted, ZIP64, split, and data-descriptor-mismatched archives;
- duplicate names, including names that differ only in case (OPC part names are
  case-insensitive, and so is SheetJS's lookup);
- ambiguous names (`..`, `.`, `//`, absolute paths, backslashes, control characters); directory
  entries ending in `/` are kept;
- macro projects (`vbaProject.bin`);
- more than `maxArchiveEntries` (10,000) entries.

Parsers get archives rebuilt from the validated parts (SheetJS a narrower one, below). 10x ran this only for email
attachments and LMK only for XLSX. The package runs it for every DOCX, XLSX, and PPTX, because
mammoth (JSZip) and the PPTX reader (fflate) are exposed to the same zip bombs. As a deliberate
tightening, OOXML input missing `[Content_Types].xml` or its main part (`word/document.xml`,
`xl/workbook.xml`, `ppt/presentation.xml`) now fails with `FileExtractionError`.

### SheetJS input: an allowlist, not a filter

SheetJS chooses its parser from the archive contents, and parses leniently. `parse_zip` checks
`META-INF/manifest.xml`, `objectdata.xml` (ODS/UOC) and `Index/Document.iwa` (Numbers) before it
reads content types, and falls back to any `Index.zip`. Its ZIP reader stores each entry as
`"Root Entry/" + name` with the first `//` collapsed (`cfb_add`), and `safegetzipfile` strips
`Root Entry/`, treats `\` as `/`, and compares names ignoring case, so `META-INF//manifest.xml` is
the ODS manifest. Every part whose requested path ends in `.bin` goes to a binary (XLSB) parser:
the workbook named by a content-type override, shared strings, styles, external links, and
metadata named by overrides, sheets named by workbook relationships (a missing or unknown `Type`
counts as a sheet), and comments named by worksheet relationships. Its tag pattern (`tagregex1`)
lets quoted values contain `<`, and attribute names are case-sensitive (`type` is not `Type`).
`parse_ws_bin` expands each `BrtHLink` range into per-cell objects and `parse_ods` expands
repeated rows and columns, and none of those parts pass through the XML hyperlink strip.

Two review rounds showed that imitating this in detection rules keeps losing (`//` collapse,
case-sensitive `Type`, `<` inside quoted values). So the guarantee comes from construction:
SheetJS never receives the uploaded archive. A third round showed that choosing the parser is
not enough: SheetJS's XML parsers also do far more work than the size of some allowed parts.
`unescapexml` recurses over an unterminated CDATA section with quadratic output.
`parse_wb_xml` decodes the whole prefix of the workbook at every `</definedName>`. Sheets that
share an `r:id`, or that only SheetJS's grammar sees (`<` inside a quoted value), parse one
worksheet once per declaration. And with `cellText` it re-parses a cell's number format for
every cell. So parts SheetJS reads are generated or checked, never copied blindly.
`buildSheetJsInput` writes a new stored archive with only these entries, each under its canonical
name:

| Entry                        | Source and reason                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `[Content_Types].xml`        | Generated. Names the XML workbook and the parts below, so no attacker `Override` or `PartName` exists.                                       |
| `_rels/.rels`                | Generated. SheetJS 0.20.3 does not read it; kept so the input is a well-formed OPC package.                                                  |
| `xl/workbook.xml`            | Generated: the sheets in order (name, `sheetId`, hidden state, `r:id="rId<n>"`) and `date1904`; no defined names, views, or calc properties. |
| `xl/_rels/workbook.xml.rels` | Generated: `rId<n>` → `worksheets/sheet<n>.xml` for every sheet.                                                                             |
| `xl/worksheets/sheet<n>.xml` | Copied: sheet `n`'s worksheet, when its relationship is an internal worksheet resolving to an `.xml` part.                                   |
| `xl/sharedStrings.xml`       | Copied: shared strings (by workbook relationship, else the conventional path): cell text.                                                    |
| `xl/styles.xml`              | Generated: number formats and one cell format per source cell format (`cell.w` for dates, percentages, currency).                            |

Generated workbook. The extractor reads `xl/workbook.xml` twice: with SheetJS's own grammar
(`tagregex1`, `parsexmltag`, `strip_ns(head) === '<sheet'`) and with a strict `[^<>]*` scan. The
counts and raw names must agree, and either count above `maxXlsxSheets` fails first. Names are
decoded as SheetJS decodes them (`unescapexml(utf8read(…))`) and re-escaped so SheetJS reads
them back exactly. A name that is missing, holds CDATA, or repeats another ignoring case (as
Excel compares them) is rejected, as are a workbook with no sheets and two sheets on one
worksheet part. SheetJS therefore sees exactly the sheets the extractor counted, and each
worksheet part is parsed at most once. Sheets without a usable worksheet (chart sheets, non-XML
parts) keep their name and position, but their `sheet<n>.xml` does not exist, so SheetJS skips
them. SheetJS needs nothing else from the workbook for cell values: `parse_wb_defaults` fills
the rest.

Generated styles. The stylesheet is read the way `parse_sty_xml` reads it (comments and doctype
removed, the first `numFmts` and `cellXfs` regions, SheetJS's tag grammar). The extractor keeps
`numFmt` codes of at most 255 characters after unescaping, which is Excel's own limit, with no
CDATA, and at most 1,000 of them. It writes one `<xf numFmtId>` per source `xf`, in order, so
cell `s` indexes keep their meaning, up to Excel's 64,000. Dropped formats show as General.
Fonts, fills, borders, cell styles, and dxfs are read only with `cellStyles`, so they are left
out. The positive controls (Excel-like, LibreOffice-shaped, and Google-Sheets-shaped workbooks,
dates, 1904 dates, percentages, currency, and text formats) match SheetJS reading the original
file.

Copied parts. A worksheet or shared-strings part in which SheetJS could meet `<![CDATA[`, raw or
after one `unescapexml` in any text view, is rejected: `str` cells are decoded twice, so
`&lt;![CDATA[` counts too. Excel, LibreOffice, and Google Sheets never write CDATA there. The
title is read from `docProps/core.xml` by the extractor (`str_match_xml` on `dc:title`, then
`unescapexml`), so core properties never reach SheetJS.

Left out because SheetJS does not need them for cell values or display text: themes (read only
with `cellStyles`), `docProps/*`, worksheet relationships, comments and threaded comments, VML
and drawings, `.bin` parts, `META-INF/*`, `Index*`, `objectdata.xml`, external links, pivot
caches, calculation chains, metadata, people, and `customXml`.

Why `parse_zip` can only take the XLSX path with this input (checked against
`node_modules/xlsx/xlsx.mjs` 0.20.3): the archive starts with a ZIP local header, so `readSync`
calls `read_zip`; no entry normalises to a marker, so neither `parse_ods` nor
`parse_numbers_iwa` runs, and `[Content_Types].xml` exists, so `Index.zip` is never looked up;
the generated content types list `/xl/workbook.xml` as the only workbook, so `xlsb` stays false
and `parse_wb` takes the XML branch; every entry ends in `.xml` or `.rels`, and `safegetzipfile`
returns only an entry whose name equals the requested path ignoring case, so no request ending in
`.bin` can return data and the binary parsers never receive any. Generated relationships make
every included sheet a worksheet, so `parse_cs`, `parse_ms`, and `parse_ds` are not reached
either.

The routing checks in `xlsx-routing.ts` remain as a fast, exact early rejection with a clear
error, not as the guarantee: marker entries (after SheetJS's path normalisation), any
`Root Entry/` name, XLSB content types in overrides, and relationship targets or override part
names whose path ends in `.bin`, except types SheetJS never parses (printer settings, OLE objects,
ActiveX binaries, custom properties, attached toolbars, images, hyperlinks). Tags are scanned with
SheetJS's own `tagregex1` and attributes read as `parsexmltag` does (exact case, prefix dropped,
unprefixed names cut at `_`, last value wins), raw and after SheetJS's unescaping, across UTF-16
views. Only the `Target` or `PartName` suffix counts, so `data.bin.xml`, an `archive.bin/`
directory, or `Id="rId.bin"` pass. `<Default>` entries are ignored: SheetJS does not route by them,
and its own XLSX writer declares `bin` as the XLSB workbook type. `normalizeOfficeArchive` runs
the same checks but keeps every part (printer settings, comments, …) so stored files still open;
it is not SheetJS input.

### Formulas

SheetJS runs with `cellFormula: false`. With formulas on (its default), each dependent of a
shared formula gets its own shifted copy of the master (`shift_formula_xlsx`): a 1 MB master that
compresses to about 1 KB and 5,000 dependents retain gigabytes of strings inside `read`, before
any budget. Each array formula also joins a list that is scanned for every later cell, which is
quadratic. Without formulas, cells keep their cached value (`<v>`) and display text, and a
formula without a cached value renders empty: no `=formula` text and no marker. The renderer's
old `=formula` fallback is gone.

This matches the common extraction standard. Microsoft MarkItDown reads XLSX through pandas, and
pandas loads openpyxl with `data_only=True`: cached values only, and `None` for formulas that
were never computed. Excel, LibreOffice, and Google Sheets always store cached values. Files
generated by code (openpyxl, ExcelJS, the SheetJS writer) may not, and their formula cells read
as empty.

The other read options cut work the extractor never uses and keep `cell.w`: `cellHTML: false`
(no rich-text HTML), `cellNF`, `cellStyles`, and `cellDates: false` (no format strings or style
objects; `cellStyles` would also force stub cells), `sheetStubs: false`, `bookDeps`, `bookFiles`,
`bookProps`, `bookSheets`, `bookVBA: false`, `dense: false` (sheets keyed by address), and
`cellText: true`.

### Worker isolation

Each fix above closes a path someone found. The parsers (SheetJS's 1 MB `xlsx.mjs`, PDF.js,
mammoth) are too large to prove linear, and in-process nothing can pre-empt a synchronous
`read`: a V8 heap abort takes down the whole process and every request it serves. So every PDF,
DOCX, XLSX, and PPTX extraction runs in a fresh `worker_threads` worker
(`extraction-isolation.ts`), following `@yolk-sdk/codemode/node`.

- The input is copied into a transferred `ArrayBuffer`. The worker validates the archive, runs
  the parser, renders the bounded text, and posts only the `ExtractedFile` or a serialized error
  (with its archive cause) back. Parser objects never cross.
- `resourceLimits`: 256 MB old generation, 32 MB young generation, 4 MB stack. A 30 s wall-clock
  timer runs on `setTimeout`, not the Effect `Clock`, so a test clock cannot stall it. At most 4
  workers per layer, through a `Semaphore`. Defaults are configurable (`isolation`) and checked
  at layer build. 256 MB holds SheetJS's cells for the default limits several times over and
  PDF.js's working set for ordinary PDFs, and 4 such workers stay inside a 2 GB serverless
  function. Legitimate files parse in well under a second, so 30 s only stops runaway work.
- The worker is terminated in the scope's release on every exit, including interruption.
  `ERR_WORKER_OUT_OF_MEMORY` maps to `reason: 'resource-limit'`, the timer to `'timeout'`, a
  worker that never posted `Started` (a missing or unloadable worker file) to
  `'worker-unavailable'`, and a later crash or exit to `'worker-failed'`. All are
  `FileExtractionError`s, and the host keeps running. A worker that cannot start never falls back
  to in-process parsing.
- `isolation: 'none'` parses in the calling thread. It exists for runtimes without worker threads
  and for tests that observe SheetJS through `loadSheetJs`, and it is documented as unsafe for
  untrusted input.
- Packaging: the entry is `dist/node/extraction-worker.mjs` (subpath
  `./node/extraction-worker`). Its URL is derived at runtime from the isolation module's own
  `import.meta.url`. Turbopack copies a literal `new URL('./…', import.meta.url)` as an asset whose
  imports do not resolve, and Next.js 16.1.3 panics on `new Worker(new URL(…))`. Hosts keep
  `@yolk-sdk/extractors` and `xlsx` in `serverExternalPackages`. With that, a standalone Next.js
  16 build of a consumer installed from the packed tarball traces the worker and its imports, and
  the extraction, heap-limit, and timeout paths work from the traced files only.
- Cost: about 150–250 ms per extraction to start a worker and load Effect and the parser. A pool
  can come later.

### Residual risks

- SheetJS still parses the worksheets and shared strings as uploaded (validated,
  hyperlink-stripped, CDATA-free), and unpdf, mammoth, and the PPTX reader parse their parts. No
  other super-linear path is known with the options used, but one found later runs before the
  extractor's budgets. The worker limits are the backstop. They bound the V8 heap, stack, and
  time, not memory outside the heap (Buffers), so the input and expanded-archive limits stay.
- The generated workbook and styles follow SheetJS 0.20.3's reading. A later SheetJS that reads
  more from these parts could change display text, not safety.
- Sheet text comes from SheetJS; hyperlink annotations come from the extractor's parse of the
  same worksheet parts, mapped through the same generated sheet list.
- `examples/next` links the package from the workspace, which Turbopack bundles, so its worker
  runs from `packages/extractors/src`. Output file tracing misses the worker's 21 runtime
  packages, so a Vercel deployment of the example fails closed (`worker-unavailable`) until a
  follow-up adds a self-contained worker bundle or dist export conditions for workspace
  packages. npm consumers are not affected.

## Hyperlinks

SheetJS 0.18.5 and 0.20.3 (`parse_ws_xml_hlinks`) expand every `<hyperlink ref>` range into
per-cell objects before any caller budget runs. A 6 KB workbook with `ref="A1:XFD1048576"` exhausts
a 1 GB Node heap. LMK's fix stripped hyperlinks, which drops the links. The package keeps them
without the blow-up:

1. While validating the archive, every `<hyperlink>` tag in every part is removed with
   `/<\/?(?:[\w.-]+:)?hyperlink\b[^<>]*>/gi` on a Latin-1 view, so other bytes are unchanged. It
   matches everything SheetJS's `hlinkregex` (`/<(?:\w+:)?hyperlink [^<>]*>/`) matches. LMK's
   original `[^>]*` let each unterminated start scan to the end of the part, which is quadratic.
   Relationship targets need not end in `.xml`. Each tag becomes a space so fragments cannot join
   into a new tag (`<hyper<hyperlink …/>link …/>`). Start tags are captured as they are removed,
   at most `maxXlsxHyperlinks` (10,000) per workbook.
2. Captured tags map to worksheet names through `xl/workbook.xml` (`<sheet name r:id>`), the
   workbook relationships, and the worksheet relationships (`r:id` → `Target`,
   `TargetMode="External"`). `location` is appended as a fragment, as SheetJS does. `display`
   labels existing cells that have no text.
3. Only normalized `http:`, `https:`, and `mailto:` URLs (at most 2,048 characters; longer links
   are dropped) are shown. `display` labels are cut to 1,024 characters ending in `…`.
   Internal `#Sheet!A1` locations and other schemes (`javascript:`, `file:`) are omitted, because
   they carry little meaning for a model and cost budget.
4. In the bounded text, each existing cell of the visited range that falls inside a link is
   written as `text <url>`. A cell whose text equals the URL is not repeated, and the later link
   wins on overlap, as in SheetJS. Lookup uses a segment tree over the visited columns. Its nodes
   hold max-heaps (by document order) of the links covering them, and the sweep advances by row
   and discards ended links lazily. Work is O((links + cells) · log(columns) · log(links)), not a
   scan of every link per cell.
5. Plain text is rendered first and must fit the 512 Ki character budget, as before. Annotations
   then spend only the leftover budget, in document order. When one does not fit, or links exceed
   the cap, the cell stays plain and the output ends with one
   `[Some hyperlinks omitted: output limit]` (or `hyperlink limit`) marker. Its space is reserved
   whenever links exist, so the output never exceeds the limit, and `maxXlsxTextCharacters` must
   exceed it (at least 62). An annotation's length is checked against the leftover budget before
   it is built or CSV-scanned, so a long label over many empty cells costs constant time per cell.

Measured with `node --max-old-space-size=1024` on the research files (`/tmp/xlsx-research`)
through the built `dist` and the default layer (worker isolation). Times are for `extract` only
and include about 140 ms to start the worker. RSS growth is measured around the call and
includes the worker; peak process RSS stayed at 165–242 MB. The `r3-*` files are the round-3
attacks; the plain-SheetJS column uses the extractor's read options on the original file.

| File                   | Plain SheetJS 0.20.3 `read`               | `FileExtractor` (package)                                    |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `base.xlsx`            | links kept                                | 160 ms, +46 MB RSS, `acme.example <https://acme.example/>` … |
| `column.xlsx`          | 920 ms, 313 MB RSS                        | 180 ms, +45 MB RSS, internal link omitted                    |
| `block.xlsx`           | per-cell link expansion                   | 154 ms, +45 MB RSS, internal link omitted                    |
| `fullsheet.xlsx`       | heap exhausted at 1 GB (crash)            | 154 ms, +46 MB RSS, internal link omitted                    |
| `quadratic.xlsx`       | quadratic hyperlink scan                  | 199 ms, +41 MB RSS, links kept                               |
| `ods-disguise.xlsx`    | ODS repeat expansion                      | 145 ms, rejected before SheetJS loads                        |
| `ods-doubleslash.xlsx` | ODS through `META-INF//manifest.xml`      | 152 ms, rejected (`//` entry name)                           |
| `bin-target.xlsx`      | XLSB `BrtHLink` expansion                 | 145 ms, rejected before SheetJS loads                        |
| `lowercase-type.xlsx`  | XLSB through a lower-case `type`          | 131 ms, rejected before SheetJS loads                        |
| `r3-definedname.xlsx`  | 300,000 `</definedName>`: > 60 s, killed  | 245 ms, +104 MB RSS, text extracted (no defined names)       |
| `r3-numfmt.xlsx`       | 1 MB format × 2,000 cells: heap exhausted | 179 ms, +48 MB RSS, cells show General                       |
| `r3-cdata.xlsx`        | 3 CDATA cells (2 KB file): 2.9 GB RSS     | 142 ms, rejected (CDATA)                                     |
| `r3-sheets.xlsx`       | 2,000 hidden `<sheet>`s: heap exhausted   | 149 ms, rejected (sheet limit)                               |

## UTF-16 parts

SheetJS decodes BOM-marked UTF-16 parts itself (`cc2str`), and the Latin-1 strip cannot see tags
inside them. Removing a decoy tag can also realign UTF-16 text or create a BOM. Following taus,
the check runs on the stripped bytes SheetJS will parse. It covers little- and big-endian
decodings from byte 2 and SheetJS's `arr[1]/arr[2]` offset check, and rejects the archive when a
hyperlink tag appears. Excel never writes UTF-16 parts, so rejecting costs nothing in practice and
avoids a second decoder.

## Other deltas reviewed

- LMK vs 10x: XLSX normalization before SheetJS and the hyperlink strip with its two bypass tests
  (nested tag, non-XML relationship target), kept and generalized as above. LMK has no other
  delta.
- taus (commit 6729332): the UTF-16 guard and its tests were kept. Its current tree equals 10x.
- yolk example and speldosa: older subsets of 10x (`sheet_to_csv`, no archive validation, no PDF
  release on failure). One generic delta was kept: `UnsupportedFileFormatError` has a `message`
  getter (`Unsupported file format: <name>`), which hosts already show to users.
- New in the package: an input byte limit for every format, PDF input is copied before PDF.js
  can detach the caller's buffer, SheetJS cells and sheets are read as own properties only, and
  the runtime SheetJS version check.

## Rejected alternatives

- **Pin npm `xlsx@0.18.5` and rely on stripping.** This leaves both CVEs in place.
- **Bundle or vendor SheetJS.** That would republish a third-party tarball under our name and
  conflict with SheetJS's own distribution.
- **Depend on the CDN URL.** npm consumers would install from a URL, and some registries and
  policies reject that.
- **Strip hyperlinks without reading them.** This is safe, but loses links the operator wants the
  model to see.
- **Cap hyperlink ranges and let SheetJS parse them.** SheetJS allocates before any cap could
  apply, and capped ranges still cost memory per cell.

## Implementation and acceptance

- `packages/extractors` with `README.md`, `AGENTS.md`, tests generated in code (no binary
  fixtures), boundary rules, export and smoke checks, and a changeset.
- `examples/next` consumes `@yolk-sdk/extractors` and installs SheetJS 0.20.3 from the CDN. Its
  copy of the extractor is deleted.
- Other apps (10x, taus, LMK, speldosa) migrate in their own repositories.
