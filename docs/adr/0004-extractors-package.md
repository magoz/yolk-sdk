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
| Routing    | XLSX input SheetJS would parse as XLSB, ODS, or Numbers is rejected; SheetJS never receives `.bin` parts.                     |
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
  hosts that validate Office bytes outside extraction, as 10x does for email attachments.
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
- duplicate or ambiguous names (`..`, absolute paths, control characters);
- macro projects (`vbaProject.bin`);
- more than `maxArchiveEntries` (10,000) entries.

Parsers get a fresh stored-entry ZIP of the validated parts. 10x ran this only for email
attachments and LMK only for XLSX. The package runs it for every DOCX, XLSX, and PPTX, because
mammoth (JSZip) and the PPTX reader (fflate) are exposed to the same zip bombs. As a deliberate
tightening, OOXML input missing `[Content_Types].xml` or its main part (`word/document.xml`,
`xl/workbook.xml`, `ppt/presentation.xml`) now fails with `FileExtractionError`.

### SheetJS parser routing

SheetJS chooses its parser from the archive contents. `parse_zip` checks `META-INF/manifest.xml`,
`objectdata.xml` (ODS/UOC) and `Index/Document.iwa` (Numbers) case-insensitively before it reads
content types, and falls back to any `Index.zip` (matched by base name). Every part whose path
ends in `.bin` goes to a binary (XLSB) parser: the workbook named by a `[Content_Types].xml`
workbook override, shared strings, styles, external links, and metadata named by overrides, sheets
named by workbook relationships, and comments named by worksheet relationships. `parse_ws_bin`
expands each `BrtHLink` range into per-cell objects and `parse_ods` expands repeated rows and
columns, and none of those parts pass through the XML hyperlink strip. So XLSX input is rejected
before SheetJS loads when it contains an ODS or Numbers marker entry, a `Root Entry/` name (the
SheetJS container strips that prefix), an `<Override>` with an XLSB content type, a workbook part
other than `/xl/workbook.xml`, or a `.bin` part outside an allowlist of content types SheetJS never
parses, or a `.bin` relationship target outside an allowlist of relationship types SheetJS never
follows into a parser (printer settings, OLE objects, ActiveX binaries, custom properties, toolbars,
images, hyperlinks). Targets are compared raw and after SheetJS's unescaping (entities, `_xHHHH_`,
CDATA), across UTF-16 views. `<Default>` entries are ignored: SheetJS does not route by them, and
its own XLSX writer declares `bin` as the XLSB workbook type. As an allowlist backstop, the archive
handed to SheetJS omits every `.bin` part, so the binary parsers cannot receive data even if a
check misses a path; `normalizeOfficeArchive` keeps those parts so stored files still open.

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

Measured with `node --max-old-space-size=1024` on the research files (`/tmp/xlsx-research`). Times
are for `extract` only. RSS includes about 220 MB of tsx and module loading, measured before the
call.

| File             | Plain SheetJS 0.20.3 `read`    | `FileExtractor` (package)                                  |
| ---------------- | ------------------------------ | ---------------------------------------------------------- |
| `base.xlsx`      | links kept                     | 37 ms, +9 MB RSS, `acme.example <https://acme.example/>` … |
| `column.xlsx`    | 920 ms, 313 MB RSS             | 38 ms, +17 MB RSS, internal link omitted                   |
| `fullsheet.xlsx` | heap exhausted at 1 GB (crash) | 38 ms, +17 MB RSS, internal link omitted                   |

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
