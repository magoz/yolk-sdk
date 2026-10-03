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
| SheetJS    | SheetJS only reads an allowlisted archive the extractor builds; XLSB/ODS/Numbers input is also rejected early.                |
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
loadSheetJs })`. It covers PDF (`unpdf`), DOCX (`mammoth`), XLSX (SheetJS), and PPTX and archive
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
of mocking modules.

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
SheetJS never receives the uploaded archive. `buildSheetJsInput` writes a new stored archive with
only these entries, each a validated, hyperlink-stripped part found by case-insensitive name and
written under its canonical name:

| Entry                        | Source and reason                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `[Content_Types].xml`        | Generated. Names the XML workbook and the parts below, so no attacker `Override` or `PartName` exists. |
| `_rels/.rels`                | Generated. SheetJS 0.20.3 does not read it; kept so the input is a well-formed OPC package.            |
| `xl/workbook.xml`            | The validated main part: sheet names, order, and the 1904 date system.                                 |
| `xl/_rels/workbook.xml.rels` | Generated: one worksheet relationship per included sheet, ids copied only when they need no escaping.  |
| `xl/worksheets/sheet<n>.xml` | Sheet `n`'s worksheet, when its relationship is a worksheet resolving to `xl/worksheets/*.xml`.        |
| `xl/sharedStrings.xml`       | Shared strings (by workbook relationship, else the conventional path): cell text.                      |
| `xl/styles.xml`              | Number formats and cell formats: SheetJS's display text (`cell.w`) for dates, percentages, …           |
| `docProps/core.xml`          | Core properties (by package relationship, else the conventional path): the workbook title.             |

Sheet `n` is stored as `xl/worksheets/sheet<n>.xml`, which is also where SheetJS looks when it
cannot match a relationship, and each source part is stored once, so a part shared by several
sheets is parsed once. A workbook with more `<sheet>` elements than `maxXlsxSheets` fails before
SheetJS. Left out because SheetJS does not need them for cell values or display text: themes
(read only with `cellStyles`), `docProps/app.xml` (sheet names come from the workbook),
worksheet relationships, comments and threaded comments, VML and drawings, `.bin` parts,
`META-INF/*`, `Index*`, `objectdata.xml`, external links, pivot caches, calculation chains,
metadata, people, and `customXml`.

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

### Residual risks

- SheetJS still parses the allowlisted XML parts (workbook, worksheets, shared strings, styles,
  core properties) with its own code. Hyperlinks are stripped and formulas, comments, and drawings
  are out, but any other expansion inside those parsers runs before the extractor's budgets; the
  cell-visit and character limits apply only afterwards.
- Our `<sheet>` count can differ from SheetJS's for malformed `xl/workbook.xml` (for example `<`
  inside a quoted attribute). Sheets SheetJS sees beyond ours have no part to read and are skipped,
  but SheetJS still walks them.
- Sheet text comes from SheetJS; hyperlink annotations come from the extractor's own parse of the
  same parts. For malformed workbooks the two can disagree, which can only drop annotations.

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
through the built `dist`. Times are for `extract` only; RSS growth is measured around the call
(peak process RSS stayed at 123–149 MB).

| File                | Plain SheetJS 0.20.3 `read`    | `FileExtractor` (package)                                  |
| ------------------- | ------------------------------ | ---------------------------------------------------------- |
| `base.xlsx`         | links kept                     | 24 ms, +8 MB RSS, `acme.example <https://acme.example/>` … |
| `column.xlsx`       | 920 ms, 313 MB RSS             | 31 ms, +9 MB RSS, internal link omitted                    |
| `fullsheet.xlsx`    | heap exhausted at 1 GB (crash) | 30 ms, +9 MB RSS, internal link omitted                    |
| `ods-disguise.xlsx` | ODS repeat expansion           | 4 ms, rejected before SheetJS loads                        |
| `bin-target.xlsx`   | XLSB `BrtHLink` expansion      | 7 ms, rejected before SheetJS loads                        |

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
