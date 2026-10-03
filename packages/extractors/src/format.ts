export const extractedFileFormats = [
  'csv',
  'docx',
  'json',
  'markdown',
  'pdf',
  'pptx',
  'text',
  'xlsx'
] as const

export type ExtractedFileFormat = (typeof extractedFileFormats)[number]

/** Office Open XML formats; their ZIP archives are validated before any parser reads them. */
export type OfficeFileFormat = 'docx' | 'pptx' | 'xlsx'

export type FileInput = {
  readonly filename: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

export type ExtractedFileMetadata = {
  readonly format: ExtractedFileFormat
  readonly title?: string
  readonly pageCount?: number
  readonly sheetNames?: ReadonlyArray<string>
}

export type ExtractedFile = {
  readonly content: string
  readonly metadata: ExtractedFileMetadata
}

const extensionFor = (filename: string) => {
  const lower = filename.toLowerCase()
  const dotIndex = lower.lastIndexOf('.')

  return dotIndex === -1 ? '' : lower.slice(dotIndex + 1)
}

const formatsByExtension: ReadonlyMap<string, ExtractedFileFormat> = new Map([
  ['txt', 'text'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['csv', 'csv'],
  ['json', 'json'],
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['xlsx', 'xlsx'],
  ['pptx', 'pptx']
])

const formatsByMediaType: ReadonlyMap<string, ExtractedFileFormat> = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/json', 'json'],
  ['text/csv', 'csv'],
  ['text/markdown', 'markdown']
])

/**
 * Pick the extraction format: the filename extension wins, then the media type, then any
 * `text/*` media type as plain text. `undefined` means the file is unsupported.
 */
export const fileFormatFor = (input: {
  readonly filename: string
  readonly mediaType: string
}): ExtractedFileFormat | undefined => {
  const byExtension = formatsByExtension.get(extensionFor(input.filename))

  if (byExtension !== undefined) return byExtension

  const byMediaType = formatsByMediaType.get(input.mediaType)

  if (byMediaType !== undefined) return byMediaType

  return input.mediaType.startsWith('text/') ? 'text' : undefined
}

export const isOfficeFileFormat = (format: ExtractedFileFormat): format is OfficeFileFormat =>
  format === 'docx' || format === 'pptx' || format === 'xlsx'
