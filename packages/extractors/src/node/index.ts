// Node-only implementation: PDF (unpdf), DOCX (mammoth), XLSX (SheetJS, an optional peer loaded
// lazily), PPTX (fflate), and bounded Office archive validation on node:zlib/node:stream. Parsers
// run in a `worker_threads` worker (`./extraction-worker`) unless `isolation: 'none'`.

export { FileExtractorLayer, makeFileExtractorLayer } from './live-layer.ts'

export type { FileExtractorOptions } from './live-layer.ts'

export { defaultWorkerIsolation } from './extraction-isolation.ts'

export type { FileExtractorIsolation, WorkerIsolationOptions } from './extraction-isolation.ts'

export { normalizeOfficeArchive } from './office-archive.ts'

export type { OfficeArchiveLimits } from './office-archive.ts'

export type { SheetJsLoader } from './sheetjs.ts'

export { FileExtractor } from '../service.ts'

export type { FileExtractorApi } from '../service.ts'
