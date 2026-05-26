import { Array as Arr, Option } from 'effect'
import * as Schema from 'effect/Schema'

export class TextPart extends Schema.TaggedClass<TextPart>()('Text', {
  text: Schema.String
}) {}

export class ImagePart extends Schema.TaggedClass<ImagePart>()('Image', {
  data: Schema.String,
  mimeType: Schema.String
}) {}

export class DocumentPart extends Schema.TaggedClass<DocumentPart>()('Document', {
  data: Schema.String,
  mimeType: Schema.String,
  filename: Schema.String,
  title: Schema.optional(Schema.String)
}) {}

export class AudioPart extends Schema.TaggedClass<AudioPart>()('Audio', {
  data: Schema.String,
  format: Schema.Literals(['pcm16', 'wav', 'mp3', 'opus'])
}) {}

export const ContentPart = Schema.Union([TextPart, ImagePart, DocumentPart, AudioPart])
export type ContentPart = typeof ContentPart.Type

export const Content = Schema.Union([Schema.String, Schema.Array(ContentPart)])
export type Content = typeof Content.Type

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
