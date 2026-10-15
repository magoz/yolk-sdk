import type { ConnectorActionFile } from './action.ts'

const mimeTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u

// `type/subtype` of a declared MIME type, or undefined (connectors never import the agent
// protocol outside `agent.ts`; tool resolution normalizes again when it stores the file).
const declaredMimeType = (mimeType: string | null | undefined) => {
  const essence = (mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''

  return mimeTypePattern.test(essence) && essence !== 'application/octet-stream'
    ? essence
    : undefined
}

type Signature = {
  readonly offset: number
  readonly bytes: ReadonlyArray<number>
  readonly mimeType: string
}

const ascii = (text: string) => Array.from(text, character => character.charCodeAt(0))

// Checked in order: RIFF containers are told apart by their format marker at byte 8.
const signatures: ReadonlyArray<ReadonlyArray<Signature>> = [
  [{ offset: 0, bytes: ascii('%PDF-'), mimeType: 'application/pdf' }],
  [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mimeType: 'image/png' }],
  [{ offset: 0, bytes: [0xff, 0xd8, 0xff], mimeType: 'image/jpeg' }],
  [{ offset: 0, bytes: ascii('GIF8'), mimeType: 'image/gif' }],
  [
    { offset: 0, bytes: ascii('RIFF'), mimeType: 'image/webp' },
    { offset: 8, bytes: ascii('WEBP'), mimeType: 'image/webp' }
  ],
  [
    { offset: 0, bytes: ascii('RIFF'), mimeType: 'audio/wav' },
    { offset: 8, bytes: ascii('WAVE'), mimeType: 'audio/wav' }
  ],
  [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mimeType: 'application/zip' }]
]

const headBytes = (base64: string) => {
  try {
    return Uint8Array.from(globalThis.atob(base64.slice(0, 16)), character =>
      character.charCodeAt(0)
    )
  } catch {
    return new Uint8Array(0)
  }
}

/** The MIME type of standard base64 bytes with a well-known signature, if any. */
export const sniffBase64MimeType = (base64: string) => {
  const head = headBytes(base64)

  return signatures.find(parts =>
    parts.every(part => part.bytes.every((byte, index) => head[part.offset + index] === byte))
  )?.[0]?.mimeType
}

/**
 * A file an action yields (ADR 0009): the declared MIME type when it is a specific `type/subtype`,
 * else the sniffed one, else `application/octet-stream`.
 */
export const connectorActionFile = (input: {
  readonly base64: string
  readonly mimeType?: string | null
  readonly filename?: string | null
}): ConnectorActionFile => {
  const mimeType =
    declaredMimeType(input.mimeType) ??
    sniffBase64MimeType(input.base64) ??
    'application/octet-stream'

  const filename = input.filename ?? undefined

  return filename === undefined || filename.length === 0
    ? { base64: input.base64, mimeType }
    : { base64: input.base64, mimeType, filename }
}
