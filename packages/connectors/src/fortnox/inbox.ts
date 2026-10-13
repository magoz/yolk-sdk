import { Chunk, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  OpaqueId,
  SafeText,
  decodeInput,
  decodeMetadata,
  failTransfer,
  fileBytes,
  validateTransfer,
  validateUpload,
  writeBytes
} from '../transfer-internal.ts'
import { closedInput, Identifier, NullableNumber, NullableString } from './fields.ts'
import { FortnoxInboxOAuthCredentialSlot } from './oauth.ts'
import { deleteFortnox, fortnoxApiBaseUrl, readFortnox } from './shared.ts'
import { downloadFortnoxBytes, resolveFortnoxTransferToken } from './transfer.ts'
import { WireNullableNumber } from './wire.ts'

/** Inbox file or folder Id (`root`, a static folder such as `inbox_s`, or a Fortnox GUID). */
export const FortnoxInboxId = Identifier.pipe(Schema.brand('FortnoxInboxId'))

export type FortnoxInboxId = typeof FortnoxInboxId.Type

// Fortnox docs: the inbox root always holds these nine static folders.
export const fortnoxInboxStaticFolderIds = [
  'inbox_a',
  'inbox_d',
  'inbox_s',
  'inbox_v',
  'inbox_b',
  'inbox_l',
  'inbox_kf',
  'inbox_o',
  'inbox_of'
] as const

export class FortnoxInboxFile extends Schema.Class<FortnoxInboxFile>('FortnoxInboxFile')({
  Id: FortnoxInboxId,
  Name: NullableString,
  Path: NullableString,
  /** Bytes. */
  Size: NullableNumber,
  /** Id of the same file in the Fortnox archive. */
  ArchiveFileId: NullableString,
  Comments: NullableString
}) {}

/** Subfolder entry of a folder listing; read it with its own Id for its files. */
export class FortnoxInboxSubfolder extends Schema.Class<FortnoxInboxSubfolder>(
  'FortnoxInboxSubfolder'
)({
  Id: FortnoxInboxId,
  Name: NullableString,
  Email: NullableString
}) {}

export class FortnoxInboxFolder extends Schema.Class<FortnoxInboxFolder>('FortnoxInboxFolder')({
  Id: FortnoxInboxId,
  Name: NullableString,
  /** Unique address that delivers emailed attachments into this folder. */
  Email: NullableString,
  Files: Schema.Chunk(FortnoxInboxFile),
  Folders: Schema.Chunk(FortnoxInboxSubfolder)
}) {}

export class FortnoxGetInboxFolderInput extends Schema.Class<FortnoxGetInboxFolderInput>(
  'FortnoxGetInboxFolderInput'
)({
  folderId: Schema.optional(FortnoxInboxId)
}) {}

const isFolderId = (id: string) => {
  const lower = id.toLowerCase()

  return lower === 'root' || fortnoxInboxStaticFolderIds.some(folder => folder === lower)
}

// `root` and the static folders hold every scanned document of their kind; deleting one would
// wipe the whole folder, so the action refuses them before any request.
export class FortnoxDeleteInboxItemInput extends Schema.Class<FortnoxDeleteInboxItemInput>(
  'FortnoxDeleteInboxItemInput'
)({
  itemId: FortnoxInboxId.check(
    Schema.makeFilter(id =>
      isFolderId(id) ? 'Expected a file or subfolder Id, not root or a static inbox folder' : true
    )
  )
}) {}

export class FortnoxDeleteInboxItemOutput extends Schema.Class<FortnoxDeleteInboxItemOutput>(
  'FortnoxDeleteInboxItemOutput'
)({
  itemId: FortnoxInboxId,
  deleted: Schema.Literal(true)
}) {}

// Fortnox docs type Size as String (the official SDK models it as a string) while the JSON
// examples and OpenAPI send an integer; accept both at the wire only.
const FortnoxInboxFileApi = Schema.Struct({ ...FortnoxInboxFile.fields, Size: WireNullableNumber })

const inboxFileFromApi = (value: typeof FortnoxInboxFileApi.Type) => FortnoxInboxFile.make(value)

// Missing Files/Folders arrays fail decoding rather than reading as an empty folder.
const FolderResponse = Schema.Struct({
  Folder: Schema.Struct({
    Id: FortnoxInboxId,
    Name: NullableString,
    Email: NullableString,
    Files: Schema.Array(FortnoxInboxFileApi),
    Folders: Schema.Array(Schema.Struct(FortnoxInboxSubfolder.fields))
  })
})

const FileResponse = Schema.Struct({ File: FortnoxInboxFileApi })

const inboxPath = (id: string) => `inbox/${encodeURIComponent(id)}`

export const fortnoxGetInboxFolderAction = defineAction({
  id: 'fortnox.get_inbox_folder',
  description:
    'Read a Fortnox inbox folder by folderId: its files (Id, Name, Size, ArchiveFileId) and direct subfolders. Omit folderId for the root, which holds the static folders inbox_a (asset register), inbox_d (daily takings), inbox_s (supplier invoices), inbox_v (vouchers), inbox_b (bank files), inbox_l (payroll), inbox_kf (customer invoices), inbox_o (orders), inbox_of (offers). Pass folder Ids only: a file Id makes Fortnox return the file content, which this action cannot read.',
  access: 'read',
  inputSchema: FortnoxGetInboxFolderInput,
  outputSchema: FortnoxInboxFolder,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxInboxOAuthCredentialSlot,
      input.folderId === undefined ? 'inbox' : inboxPath(input.folderId),
      FolderResponse,
      ({ Folder }) =>
        FortnoxInboxFolder.make({
          Id: Folder.Id,
          Name: Folder.Name,
          Email: Folder.Email,
          Files: Chunk.fromIterable(Folder.Files.map(inboxFileFromApi)),
          Folders: Chunk.fromIterable(Folder.Folders.map(f => FortnoxInboxSubfolder.make(f)))
        })
    )
})

export const fortnoxDeleteInboxItemAction = defineAction({
  id: 'fortnox.delete_inbox_item',
  description:
    'Permanently delete a Fortnox inbox file or subfolder by its Id. Deleting a subfolder also deletes every file and subfolder inside it. This cannot be undone. `root` and the static folders (inbox_s, inbox_v, ...) are refused.',
  access: 'destructive',
  inputSchema: closedInput(FortnoxDeleteInboxItemInput.fields),
  outputSchema: FortnoxDeleteInboxItemOutput,
  execute: ({ integration, input }) =>
    deleteFortnox(
      integration,
      FortnoxInboxOAuthCredentialSlot,
      inboxPath(input.itemId),
      FortnoxDeleteInboxItemOutput.make({ itemId: input.itemId, deleted: true })
    )
})

export const fortnoxInboxActions = [
  fortnoxGetInboxFolderAction,
  fortnoxDeleteInboxItemAction
] as const

// Host-only byte helpers below: not actions, never in agent serialization.

// GET /inbox/{Id} answers a folder Id with folder JSON (200), which would pass as file bytes.
const InboxDownloadInput = Schema.Struct({
  fileId: OpaqueId.check(Schema.makeFilter(id => !isFolderId(id)))
})

/**
 * Download the bytes of one inbox file by its Id (from `fortnox.get_inbox_folder`). Uses the
 * `inbox` scope. Ids of `root` and the static folders are rejected; other folder Ids cannot be
 * told apart from file Ids before the request, so pass file Ids only.
 */
export const downloadFortnoxInboxFile = (
  integration: ConnectorIntegration,
  input: { readonly fileId: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const target = yield* decodeInput(InboxDownloadInput, input)

    const response = yield* downloadFortnoxBytes(
      integration,
      FortnoxInboxOAuthCredentialSlot,
      inboxPath(target.fileId),
      budget,
      'binary'
    )

    return { ...fileBytes(response.bytes), source: { id: target.fileId } }
  })

/**
 * Fortnox documents no inbox upload limit. 50 MiB is a conservative single-request cap that keeps
 * the whole multipart body in one buffer bounded; larger files fail `upload_session_required`
 * (Fortnox has no session upload, so they cannot be uploaded through this helper).
 */
export const fortnoxInboxUploadMaxBytes = 50 * 1024 * 1024

export interface FortnoxInboxUploadInput {
  /** Target folder Id (`root`, a static folder such as `inbox_s`, or a folder GUID). */
  readonly folderId: string
  /** File name Fortnox stores, with extension. */
  readonly fileName: string
  /** Part media type; defaults to `application/octet-stream`. */
  readonly contentType?: string
  readonly bytes: Uint8Array
}

// The name is sent as raw UTF-8 inside a quoted Content-Disposition parameter (as the official
// Fortnox SDK does), so quotes, backslashes and path separators are rejected, not escaped.
const UploadTarget = Schema.Struct({
  folderId: OpaqueId,
  fileName: SafeText.check(
    Schema.isMaxLength(255),
    Schema.makeFilter(name => !/["\\/]/.test(name) && !/^\.+$/.test(name) && name.trim() === name)
  ),
  contentType: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(255),
      Schema.isPattern(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/)
    )
  )
})

const encoder = new TextEncoder()

const boundaryPrefix = encoder.encode('yolk-fortnox-inbox-')

const boundarySuffixLength = 8

// Collect every 8-character suffix following the boundary prefix in `data`. A boundary built from
// the prefix and an unseen suffix therefore cannot occur anywhere in `data`.
const collectSuffixes = (data: Uint8Array, seen: Set<string>) => {
  const first = boundaryPrefix[0] ?? 0
  const last = data.length - boundaryPrefix.length - boundarySuffixLength

  for (let i = data.indexOf(first); i !== -1 && i <= last; i = data.indexOf(first, i + 1)) {
    if (boundaryPrefix.every((byte, offset) => data[i + offset] === byte)) {
      const start = i + boundaryPrefix.length

      seen.add(String.fromCharCode(...data.subarray(start, start + boundarySuffixLength)))
    }
  }
}

/**
 * Deterministic multipart boundary absent from every given byte sequence: the first counter
 * value whose 8-hex-digit suffix was not seen. At most `length / 19` suffixes can be seen, so a
 * free one always exists below the 2^32 hex range for any upload under the cap.
 */
const multipartBoundary = (parts: ReadonlyArray<Uint8Array>) => {
  const seen = new Set<string>()

  for (const part of parts) collectSuffixes(part, seen)

  for (let n = 0; n <= 0xffffffff; n++) {
    const suffix = n.toString(16).padStart(boundarySuffixLength, '0')

    if (!seen.has(suffix)) return Effect.succeed(`yolk-fortnox-inbox-${suffix}`)
  }

  return failTransfer('invalid_input')
}

const multipartBody = (
  boundary: string,
  fileName: Uint8Array,
  contentType: string,
  bytes: Uint8Array
) => {
  const head = [
    encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`),
    fileName,
    encoder.encode(`"\r\nContent-Type: ${contentType}\r\n\r\n`)
  ]

  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const chunks = [...head, bytes, tail]
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
}

/**
 * Upload one file into an inbox folder: a single multipart/form-data POST
 * `/inbox?folderid={folderId}` (form field `file`) with the `inbox` scope, never retried. Returns
 * the stored file metadata. A transport failure or an undecodable answer may still mean the file
 * was stored; reconcile by reading the folder before uploading again.
 */
export const uploadFortnoxInboxFile = (
  integration: ConnectorIntegration,
  input: FortnoxInboxUploadInput,
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'fortnox', budget)
    yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)
    yield* validateUpload(input.bytes, limits, fortnoxInboxUploadMaxBytes)
    const target = yield* decodeInput(UploadTarget, input)
    const fileName = encoder.encode(target.fileName)
    const boundary = yield* multipartBoundary([input.bytes, fileName])

    const body = multipartBody(
      boundary,
      fileName,
      target.contentType ?? 'application/octet-stream',
      input.bytes
    )

    const token = yield* resolveFortnoxTransferToken(integration, FortnoxInboxOAuthCredentialSlot)

    const response = yield* writeBytes({
      method: 'POST',
      url: `${fortnoxApiBaseUrl}/inbox?folderid=${encodeURIComponent(target.folderId)}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      bytes: body,
      // The file bytes are already within budget and cap; this is the exact multipart body size.
      maxUploadBytes: body.byteLength,
      maxBytes: limits.maxMetadataBytes,
      maxErrorBodyBytes: limits.maxErrorBodyBytes,
      successStatuses: [200, 201],
      redirect: 'manual',
      credentials: 'omit'
    })

    const metadata = yield* decodeMetadata(FileResponse, response.bytes)

    if (
      metadata.File.Size !== undefined &&
      metadata.File.Size !== null &&
      metadata.File.Size !== input.bytes.byteLength
    )
      return yield* failTransfer('invalid_metadata')

    return inboxFileFromApi(metadata.File)
  })
