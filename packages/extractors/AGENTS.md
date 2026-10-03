# Extractors Package

`@yolk-sdk/extractors` turns uploaded files into bounded, sanitized text (`docs/adr/0004-extractors-package.md`).
It replaces the per-app `lib/services/file-extractor` copies. It is domain-free: hosts own
upload size policy, auth, storage, and what the text is used for.

## Subpaths

| Subpath                          | Source                          | Role                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/extractors`           | `src/index.ts`                  | Types, `Schema.TaggedError` errors (`FileExtractionError` with `reason`), `FileExtractionFailureReason`, `fileFormatFor`, limits, `sanitizeExtractedText`, `FileExtractor` tag                                |
| `@yolk-sdk/extractors/node`      | `src/node/index.ts`             | `FileExtractorLayer`, `makeFileExtractorLayer`, `defaultWorkerIsolation`, `normalizeOfficeArchive`; types `FileExtractorIsolation`, `WorkerIsolationOptions` (incl. `maxConcurrentWorkers`, `maxQueueWaitMs`) |
| `…/node/extraction-worker`       | `src/node/extraction-worker.ts` | Worker entry, built as one self-contained `dist/node/extraction-worker.mjs`; a no-op when imported outside a worker                                                                                           |
| `@yolk-sdk/extractors/knowledge` | `src/knowledge.ts`              | `FileKnowledgeExtractorLayer`, `makeFileKnowledgeExtractor`                                                                                                                                                   |

Root files: `errors.ts`, `format.ts`, `limits.ts`, `sanitize.ts`, `service.ts`. Node files (`src/node/`):
`live-layer.ts` (options, dispatch to a worker or in-process), `extraction-isolation.ts` (worker
spawn, limits, timeout, default worker URL, failure reasons), `worker-admission.ts` (process-wide
and per-layer worker slots), `extraction-worker.ts` (worker entry),
`extraction-worker-protocol.ts` (message schemas, error round trip), `extract-file.ts`
(PDF/DOCX/XLSX/PPTX extraction), `office-archive.ts` (bounded ZIP validation, hyperlink strip,
UTF-16 guard), `xlsx-sheetjs-input.ts` (the archive SheetJS reads), `xlsx-workbook.ts`
(generated workbook), `xlsx-styles.ts` (generated stylesheet), `sheetjs-xml.ts` (SheetJS XML
grammar ports, CDATA check, core title), `xlsx-routing.ts` (early XLSB/ODS/Numbers rejection),
`xlsx-parts.ts` (part lookup, relationships), `sheetjs.ts` (lazy loader, version check, read
options, workbook guards), `xlsx-text.ts` (bounded CSV + annotations), `xlsx-hyperlinks.ts` (tag
resolution, indexed lookup), `xlsx-range.ts` (strict ranges), `pptx-text.ts`, `xml-text.ts`
(entities, attributes).

## Boundaries

- Root and `./knowledge` are runtime-portable: no Node builtins, no `unpdf`/`mammoth`/`xlsx`/`fflate`,
  no `./node` import. Only `src/node/**` may use them. Boundary-enforced.
- Among Yolk packages only `./knowledge` (`src/knowledge.ts`) imports `@yolk-sdk/knowledge`
  (`documents`, `errors`, `extraction`); knowledge never imports extractors. Boundary-enforced.
- SheetJS is an optional peer (`>=0.20.3`, from the SheetJS CDN tarball). Import it only through the
  injectable loader in `sheetjs.ts` (default `() => import('xlsx')`); never a static import, never
  in the root. Keep `xlsx` types out of public declarations (the loader is typed `() => Promise<unknown>`).
  The worker always uses the default loader; a `loadSheetJs` function only works with
  `isolation: 'none'` (anything else is a layer defect). unpdf and mammoth are imported lazily
  inside `extract-file.ts`.

## Design rules

- `extract` fails only with `UnsupportedFileFormatError`, `FileExtractionError`, or
  `SheetJsUnavailableError`. Map archive failures (`OfficeArchiveError`) to `FileExtractionError`
  with the archive error as `cause`; keep messages user-safe (no parser payloads).
- Every OOXML input goes through `readOfficeArchive` before any parser: bounded inflation counted
  against declared sizes and `maxExpandedBytes`, strict ZIP directory checks (no `..`, `.`, `//`,
  absolute, backslash, or control-character names, no names equal ignoring case; directory
  entries ending in `/` are fine). DOCX gets `storedArchive(parts)`, PPTX reads the validated
  parts directly, and SheetJS gets only `buildSheetJsInput(parts)`.
- XLSX: strip every `<hyperlink>` tag (`/<\/?(?:[\w.-]+:)?hyperlink\b[^<>]*>/gi`, a superset of
  SheetJS's `hlinkregex`, replaced with a space) from every part, whatever its name or type,
  Latin-1 round-trip so other bytes are unchanged, before SheetJS.
  Capture start tags as they are removed (`maxXlsxHyperlinks` + 1 to detect truncation), then
  reject parts whose stripped bytes decode as BOM-marked UTF-16 with a hyperlink tag.
- Parts SheetJS reads are generated or sanitised, never copied, unless a test proves its parser
  stays linear on them. SheetJS's XML parsers have super-linear paths that routing does not
  control: `unescapexml` over CDATA, per-cell number-format evaluation, `definedName` slicing,
  and `r:id` fan-out.
- XLSX: SheetJS never receives the uploaded archive, only `buildSheetJsInput`'s rebuild. Every
  entry has a canonical name:
  - generated: `[Content_Types].xml`, `_rels/.rels`, and `xl/_rels/workbook.xml.rels` (sheet `n`
    is `rId<n>` → `worksheets/sheet<n>.xml`);
  - generated `xl/workbook.xml` (`xlsx-workbook.ts`): sheets in order (name re-escaped so SheetJS
    reads it back exactly, `sheetId`, `hidden`/`veryHidden`) and `date1904`, nothing else. Sheets
    are counted twice, by SheetJS's grammar (`tagregex1`, `strip_ns(head) === '<sheet'`) and by
    the strict `[^<>]*` scan. Disagreeing counts or names, a missing, CDATA, or repeated (ignoring
    case) name, no sheets, or two sheets on one worksheet part are rejected as
    `XLSX workbook is malformed.`;
  - generated `xl/styles.xml` (`xlsx-styles.ts`): read with SheetJS's own regions and grammar;
    `numFmt` codes of at most 255 characters after unescaping, at most 1,000, and no CDATA; one
    `<xf numFmtId>` per source `xf`, in order, at most 64,000;
  - copied: sheet `n`'s worksheet as `xl/worksheets/sheet<n>.xml` when its relationship is an
    internal worksheet resolving to any `.xml` part, and `xl/sharedStrings.xml`. Both are rejected
    when SheetJS could meet `<![CDATA[` in any text view, raw or after any chain of up to two
    `unescapexml`/`utf8read` steps (`sheetJsCouldReadCdata`). SheetJS decodes `str` cells as
    `unescapexml(utf8read(unescapexml(raw)))`, and `utf8read` keeps only each character's low
    byte (U+013C becomes `<`). Never narrow it to counted unescapes.

  `docProps/*` is never handed over: the title comes from `coreTitle` (`sheetJsElementText` on
  `dc:title`). Themes, worksheet relationships, comments, VML, drawings, `.bin`, markers,
  external links, pivot caches, calc chains, metadata, and `customXml` are excluded. Source parts
  are found ignoring case and must end in `.xml`. Adding a part needs proof that SheetJS needs it
  for cell values or display text, a test that it cannot reach a non-XLSX parser, and generation
  or a linearity test.

- SheetJS `read` options live in `sheetJsReadOptions` (`sheetjs.ts`): `cellFormula: false`
  (shared-formula copies and array-formula scans), `cellHTML`, `cellNF`, `cellStyles`,
  `cellDates`, `sheetStubs`, `book*` off, `dense: false`, `cellText: true`. Pass a fresh copy per
  call (SheetJS writes defaults into it). Formula-only cells render empty; never re-add `=formula`.
- XLSX early rejection (`xlsx-routing.ts`, clear error only, not the guarantee): marker entries
  after SheetJS normalisation (`sheetJsEntryPath`: first `//` collapsed, `Root Entry/` stripped,
  `\` as `/`, lower case), any `Root Entry/` name, XLSB content types in overrides, and `Target` or
  `PartName` paths ending in `.bin` outside the type allowlists. Scan with SheetJS's `tagregex1`
  and read attributes as `parsexmltag` does (exact-case keys); never match `.bin` against the whole
  tag. `normalizeOfficeArchive` keeps every part and is never SheetJS input.
- Every regex over part text must stop at the next `<` (`[^<>]`) or otherwise stay linear; no
  lazy `[\s\S]*?` retried from every start (see `pptx-text.ts` `elementMatches`). The one
  exception is the routing scan's copy of SheetJS `tagregex1`: a quoted value may hold `<`, but
  each attempt stops at the next quote of its kind, so the scan stays linear.
- `buildSheetJsInput` fails a workbook with more `<sheet>` elements than `maxXlsxSheets`, counted
  by either scan (a `<` inside a quoted attribute still counts), before SheetJS runs. SheetJS then
  sees exactly the sheets the extractor counted.
- Isolation: PDF, DOCX, XLSX, and PPTX run in a fresh worker per extraction
  (`extraction-isolation.ts`). Input bytes are copied into a transferred buffer, and only the
  `ExtractedFile` or a serialized error comes back; protocol messages are built with `.make()`.
  Defaults: 256 MB old generation, 32 MB young, 4 MB stack, and a 30 s wall-clock `setTimeout`
  (never the Effect `Clock`, so a test clock cannot stall it). The worker is terminated in the
  scope's release on every exit, including interruption. Failures map to `FileExtractionError`
  `reason`: `ERR_WORKER_OUT_OF_MEMORY` → `resource-limit`, timer → `timeout`, error or exit
  before `WorkerStarted` → `worker-unavailable`, later crash, exit, or malformed message →
  `worker-failed`, no slot within `maxQueueWaitMs` → `busy`. Never fall back to in-process.
- Guarantee wording: the worker bounds V8 heap, stack, and running time, and the cap is
  process-wide. It does not bound RSS or off-heap memory (Buffers, PDF.js decoded data); those
  are limited only by the input and expanded-size caps, and the host's memory limit is the outer
  bound. Never claim the process always survives.
- Admission (`worker-admission.ts`): one pool of `processWorkerLimit` (4) slots per process, on
  `globalThis` under `Symbol.for('@yolk-sdk/extractors/worker-admission/v1')`, holding only plain
  data and callbacks (no Effect objects, so module copies share it). Each layer also has its own
  pool of `maxConcurrentWorkers` (1 to 4) that can only lower its share. Take the layer slot, then
  the process slot, with one deadline; take and register the release with no interruption point
  between them, and release only after `worker.terminate()` resolves. Bump the symbol's version
  if the pool's shape changes.
- The default worker URL (`extractionWorkerUrlFor`) maps `dist/node/extraction-isolation.mjs` or
  `src/node/extraction-isolation.ts` to the same package's built `dist/node/extraction-worker.mjs`,
  and anything else to `undefined` (fail closed, start nothing). Derive it from a string at
  runtime; never write `new URL('./…', import.meta.url)` or `new Worker(new URL(…))` for it:
  Turbopack copies the former as an asset whose imports cannot resolve, and panics on the latter.
- The worker bundle is the second `tsdown.config.ts` entry: everything bundled, dynamic imports
  inlined, only `xlsx` external. Keep `xlsx` a dynamic import there and keep the bundle free of
  any other package import (the tarball smoke checks both).
- Links resolve through `xl/workbook.xml` sheet `r:id` → workbook rels → worksheet part (any
  extension) → worksheet rels `TargetMode="External"`. Show only normalized `http:`/`https:`/`mailto:`
  targets (≤ 2,048 characters, longer links dropped), append `#location` like SheetJS; omit
  internal locations. Cap `display` at 1,024 characters (ending in `…`) at parse time.
- XLSX text is rendered plain first; annotations spend only the leftover budget in document order.
  With any links present, the marker space is reserved so `[Some hyperlinks omitted: …]` always
  fits. Later links win on overlap. Never scan every link per cell: use `makeHyperlinkLookup`.
  Check an annotation's length against the spare budget before building or CSV-scanning it.
  `maxXlsxTextCharacters` must exceed the marker reserve (`minimumXlsxTextCharacters`, 62).
- Read SheetJS sheets and cells as own properties (`ownProperty`), never through the prototype.
- Copy PDF bytes before PDF.js; release the document in a finalizer (`withAcquiredPdfDocument`).
- Invalid layer limits are defects (`Effect.orDie` at layer build), not typed failures.

## Tests

- `test/file-extractor.test.ts`: every format end to end, limits, empty/unsupported, SheetJS
  missing/outdated/invalid/CommonJS and strict SemVer (prereleases, malformed versions),
  CVE-2023-30533 regression (comment never handed over; SheetJS itself not polluted), PDF lifecycle, linear PPTX scan, minimum text limit, `fileFormatFor`.
- `test/office-archive.test.ts`: 10x archive tests, zip bombs, LMK hyperlink strip variants, taus
  UTF-16 guard (direct and through `FileExtractor`), parity with SheetJS's `hlinkregex` read from
  the installed build, and a linear-strip regression.
- `test/xlsx-routing.test.ts`: XLSB worksheets/workbooks (a hand-built `BrtHLink` record), content
  type overrides, lower-case `type`, `<` inside quoted `Target`/`PartName`, ODS/Numbers markers
  including `//` and `Root Entry/` names, allowed `.bin` parts (toolbars too), and `.bin` false
  positives. Real-SheetJS controls show each expanding route, a recording loader proves SheetJS is
  never called, and `buildSheetJsInput` on the unchecked parts shows the allowlist alone holds.
- `test/xlsx-sheetjs-input.test.ts`: shared/array formulas and many comments (controls expand,
  extraction does not), cached vs formula-only cells, generated parts, canonical names (any `.xml`
  worksheet), shared parts and shared `r:id`s, sheets only SheetJS sees (`<` in an attribute),
  repeated names, sheet limit, and positive controls (SheetJS-written and Excel-like workbooks,
  text and title).
- Every extraction test that reaches SheetJS uses `recordingSheetJs` and `expectAllowlisted` from
  `test/fixtures.ts` (through `extractRecorded`); controls call `XLSX.read` directly on fixtures
  (`readDirectly`). `extractWith` defaults to `isolation: 'none'` so the recording loader sees
  every call.
- `test/xlsx-generated-parts.test.ts`: defined-name flood, exact sheet names (`_X0041_` read
  ignoring case), 1904 dates, hidden sheets, a huge reused number format, format caps, CDATA
  (cells, shared strings, escaped, `utf8read` low-byte forms `_x013C_`, `&#x13C;`, `&#316;` with
  real-SheetJS controls, title), and LibreOffice- and Google-Sheets-shaped workbooks
  (hand-written, not real exports, compared with SheetJS).
- `test/extraction-worker.test.ts`: real workers (the source entry via `sourceWorkerUrl`) and
  SheetJS: every format matches in-process output, typed errors and causes cross the boundary, a
  16 MB heap gives `resource-limit` and the process keeps working, a 1 ms timeout, spawn failure,
  exit before and after `WorkerStarted`, a malformed message, a layer's share with real parsers,
  and layer defects. `data:` stub workers that announce themselves on a `BroadcastChannel` and
  hold their slot prove the process-wide peak of four across independent layer builds, a
  layer's lower share, `busy` after `maxQueueWaitMs`, and that interruption terminates the worker
  and frees its slot. Also the default URL mapping and failing closed with no worker URL.
- `test/xlsx-text.test.ts`: 10x bounded CSV tests (ranges, quoting, budgets, visit preflight).
- `test/xlsx-hyperlinks.test.ts`: link output, schemes, overlap, sheet mapping, full-sheet/column
  ranges (SheetJS never sees a tag, via a recording loader), budget marker, cap, display/target
  caps, lookup vs brute force. No wall-clock assertions: assert on structure and output.
- `test/knowledge.test.ts`: adapter with the real Node extractor and a fake `FileExtractor` layer;
  malformed URL escapes stay encoded and never throw.
- Fixtures are generated in `test/fixtures.ts`; no binary blobs. No module mocking: SheetJS is
  swapped through the `loadSheetJs` layer option.
