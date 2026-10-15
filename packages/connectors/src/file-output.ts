import type { ConnectorActionFile } from './action.ts'

const base64Signatures: ReadonlyArray<readonly [string, string]> = [
  ['JVBERi0', 'application/pdf'],
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
  ['UEsDB', 'application/zip']
]

/** The MIME type of standard base64 bytes with a well-known signature, if any. */
export const sniffBase64MimeType = (base64: string) =>
  base64Signatures.find(([prefix]) => base64.startsWith(prefix))?.[1]

/**
 * A file an action yields (ADR 0009): the declared MIME type when present and specific, else
 * the sniffed one, else `application/octet-stream`.
 */
export const connectorActionFile = (input: {
  readonly base64: string
  readonly mimeType?: string | null
  readonly filename?: string | null
}): ConnectorActionFile => {
  const declared = input.mimeType ?? undefined

  const mimeType =
    declared !== undefined && declared.length > 0 && declared !== 'application/octet-stream'
      ? declared
      : (sniffBase64MimeType(input.base64) ?? 'application/octet-stream')

  const filename = input.filename ?? undefined

  return filename === undefined || filename.length === 0
    ? { base64: input.base64, mimeType }
    : { base64: input.base64, mimeType, filename }
}
