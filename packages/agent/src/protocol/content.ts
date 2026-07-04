import { Array as Arr, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'

export class TextPart extends Schema.TaggedClass<TextPart>()('Text', {
  text: Schema.String
}) {}

export class InlineBase64AttachmentSource extends Schema.TaggedClass<InlineBase64AttachmentSource>()(
  'InlineBase64',
  {
    data: Schema.String
  }
) {}

export class UrlAttachmentSource extends Schema.TaggedClass<UrlAttachmentSource>()('Url', {
  url: Schema.String
}) {}

export class RefAttachmentSource extends Schema.TaggedClass<RefAttachmentSource>()('Ref', {
  id: Schema.String
}) {}

export const AttachmentSource = Schema.Union([
  InlineBase64AttachmentSource,
  UrlAttachmentSource,
  RefAttachmentSource
])
export type AttachmentSource = typeof AttachmentSource.Type

export class ImagePart extends Schema.TaggedClass<ImagePart>()('Image', {
  source: AttachmentSource,
  mimeType: Schema.String,
  filename: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number)
}) {}

export class DocumentPart extends Schema.TaggedClass<DocumentPart>()('Document', {
  source: AttachmentSource,
  mimeType: Schema.String,
  filename: Schema.String,
  title: Schema.optional(Schema.String)
}) {}

export class AudioPart extends Schema.TaggedClass<AudioPart>()('Audio', {
  source: AttachmentSource,
  mimeType: Schema.String,
  filename: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number)
}) {}

export const ContentPart = Schema.Union([TextPart, ImagePart, DocumentPart, AudioPart])
export type ContentPart = typeof ContentPart.Type

export const Content = Schema.Union([Schema.String, Schema.Array(ContentPart)])
export type Content = typeof Content.Type

export type AttachmentContentPart = ImagePart | DocumentPart | AudioPart

export type AttachmentSourceResolver<E = never, R = never> = (
  part: AttachmentContentPart
) => Effect.Effect<AttachmentSource, E, R>

const resolveContentPartAttachmentSource = <E, R>(
  part: ContentPart,
  resolver: AttachmentSourceResolver<E, R>
): Effect.Effect<ContentPart, E, R> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed(part)
    case 'Image':
      return resolver(part).pipe(
        Effect.map(source =>
          ImagePart.make({
            source,
            mimeType: part.mimeType,
            filename: part.filename,
            title: part.title,
            width: part.width,
            height: part.height
          })
        )
      )
    case 'Document':
      return resolver(part).pipe(
        Effect.map(source =>
          DocumentPart.make({
            source,
            mimeType: part.mimeType,
            filename: part.filename,
            title: part.title
          })
        )
      )
    case 'Audio':
      return resolver(part).pipe(
        Effect.map(source =>
          AudioPart.make({
            source,
            mimeType: part.mimeType,
            filename: part.filename,
            durationMs: part.durationMs
          })
        )
      )
  }
}

export const resolveContentAttachmentSources = <E, R>(
  content: Content,
  resolver: AttachmentSourceResolver<E, R>
): Effect.Effect<Content, E, R> =>
  typeof content === 'string'
    ? Effect.succeed(content)
    : Effect.forEach(content, part => resolveContentPartAttachmentSource(part, resolver))

export const contentPartText = (part: ContentPart) => {
  switch (part._tag) {
    case 'Text':
      return part.text
    case 'Image':
    case 'Document':
    case 'Audio':
      return ''
  }
}

export const contentPartPreview = (part: ContentPart) => {
  switch (part._tag) {
    case 'Text':
      return part.text
    case 'Image':
      return 'Image'
    case 'Document':
      return `Document: ${part.title ?? part.filename}`
    case 'Audio':
      return 'Audio'
  }
}

const loneSurrogates = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Replace lone UTF-16 surrogates with U+FFFD. Models emit them in transcripts
 * and tool arguments; they are valid JS strings but unencodable as UTF-8, so
 * provider APIs and storage backends can reject payloads containing them.
 */
export const replaceLoneSurrogates = (text: string) => text.replace(loneSurrogates, '\uFFFD')

/**
 * Deep-apply `replaceLoneSurrogates` to every string (keys included) in a
 * JSON-shaped value. Providers harden lowered request bodies with this before
 * serialization so junk in replayed transcripts cannot poison model calls;
 * hosts may also use it when persisting model-produced JSON.
 */
export const replaceLoneSurrogatesDeep = (value: unknown): unknown => {
  if (typeof value === 'string') return replaceLoneSurrogates(value)
  if (Array.isArray(value)) return value.map(replaceLoneSurrogatesDeep)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        replaceLoneSurrogates(key),
        replaceLoneSurrogatesDeep(entry)
      ])
    )
  }

  return value
}

export const contentText = (content: Content) =>
  typeof content === 'string' ? content : Arr.map(content, contentPartText).join('')

export const contentPreview = (content: Content) =>
  typeof content === 'string' ? content : Arr.map(content, contentPartPreview).join(', ')

export const contentParts = (content: Content): ReadonlyArray<ContentPart> =>
  typeof content === 'string' ? [TextPart.make({ text: content })] : content

export const isContentEmpty = (content: Content) =>
  typeof content === 'string'
    ? content.length === 0
    : content.length === 0 ||
      Arr.every(content, part => part._tag === 'Text' && part.text.length === 0)

export const appendTextToContent = (content: Content, text: string): Content => {
  if (typeof content === 'string') {
    return `${content}${text}`
  }

  return Option.match(Arr.last(content), {
    onNone: () => [TextPart.make({ text })],
    onSome: last =>
      last._tag !== 'Text'
        ? [...content, TextPart.make({ text })]
        : Arr.map(content, (part, index) =>
            index === content.length - 1 && part._tag === 'Text'
              ? TextPart.make({ text: `${part.text}${text}` })
              : part
          )
  })
}

export const inlineBase64AttachmentSource = (data: string) =>
  InlineBase64AttachmentSource.make({ data })

export const urlAttachmentSource = (url: string) => UrlAttachmentSource.make({ url })

export const refAttachmentSource = (id: string) => RefAttachmentSource.make({ id })

export const inlineBase64Source = inlineBase64AttachmentSource

export const attachmentSourcePreview = (source: AttachmentSource) => {
  switch (source._tag) {
    case 'InlineBase64':
      return 'inline'
    case 'Url':
      return source.url
    case 'Ref':
      return source.id
  }
}

export const attachmentSourceDataUrl = (source: AttachmentSource, mimeType: string) => {
  switch (source._tag) {
    case 'InlineBase64':
      return Option.some(`data:${mimeType};base64,${source.data}`)
    case 'Url':
    case 'Ref':
      return Option.none<string>()
  }
}

export const attachmentSourceUrl = (source: AttachmentSource, mimeType: string) => {
  switch (source._tag) {
    case 'InlineBase64':
      return Option.some(`data:${mimeType};base64,${source.data}`)
    case 'Url':
      return Option.some(source.url)
    case 'Ref':
      return Option.none<string>()
  }
}

const normalizeMimeType = (mimeType: string) =>
  mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''

const textDocumentMimeTypeByExtension: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.css': 'text/css',
  '.gql': 'application/graphql',
  '.graphql': 'application/graphql',
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.sql': 'application/sql',
  '.toml': 'application/toml',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

const isUnknownDocumentMimeType = (mimeType: string) =>
  mimeType.length === 0 ||
  mimeType === 'application/octet-stream' ||
  mimeType === 'binary/octet-stream'

export const isTextDocumentMimeType = (mimeType: string) => {
  const normalized = normalizeMimeType(mimeType)

  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized === 'application/jsonl' ||
    normalized === 'application/x-ndjson' ||
    normalized === 'application/javascript' ||
    normalized === 'application/x-javascript' ||
    normalized === 'application/typescript' ||
    normalized === 'application/x-typescript' ||
    normalized === 'application/xml' ||
    normalized === 'application/yaml' ||
    normalized === 'application/x-yaml' ||
    normalized === 'application/toml' ||
    normalized === 'application/markdown' ||
    normalized === 'application/sql' ||
    normalized === 'application/graphql' ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml')
  )
}

export const textDocumentMimeTypeFromFilename = (filename: string) => {
  const normalized = filename.trim().toLowerCase()
  const entry = Object.entries(textDocumentMimeTypeByExtension).find(([extension]) =>
    normalized.endsWith(extension)
  )

  return entry?.[1]
}

export const inferTextDocumentMimeType = (input: {
  readonly filename: string
  readonly mimeType: string
}) => {
  const normalized = normalizeMimeType(input.mimeType)

  if (isTextDocumentMimeType(normalized)) return normalized
  if (!isUnknownDocumentMimeType(normalized)) return undefined

  return textDocumentMimeTypeFromFilename(input.filename)
}

export const textToBase64Utf8 = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return globalThis.btoa(binary)
}

export const documentPartFromText = (input: {
  readonly text: string
  readonly filename: string
  readonly mimeType: string
  readonly title?: string
}) => {
  const normalized = normalizeMimeType(input.mimeType)
  const mimeType =
    inferTextDocumentMimeType({
      filename: input.filename,
      mimeType: input.mimeType
    }) ?? (isUnknownDocumentMimeType(normalized) ? 'text/plain' : undefined)

  if (mimeType === undefined) return undefined

  const base = {
    source: inlineBase64AttachmentSource(textToBase64Utf8(input.text)),
    mimeType,
    filename: input.filename
  }

  return input.title === undefined
    ? DocumentPart.make(base)
    : DocumentPart.make({ ...base, title: input.title })
}

const decodeBase64Utf8 = (data: string) => {
  const binary = globalThis.atob(data)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))

  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export const attachmentSourceText = (source: AttachmentSource) => {
  switch (source._tag) {
    case 'InlineBase64':
      return Effect.try({
        try: () => Option.some(decodeBase64Utf8(source.data)),
        catch: error => error
      })
    case 'Url':
    case 'Ref':
      return Effect.succeed(Option.none<string>())
  }
}

export const attachmentSourceBase64 = (source: AttachmentSource) => {
  switch (source._tag) {
    case 'InlineBase64':
      return Option.some(source.data)
    case 'Url':
    case 'Ref':
      return Option.none<string>()
  }
}
