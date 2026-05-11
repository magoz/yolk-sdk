import * as Schema from 'effect/Schema'

export class TextPart extends Schema.TaggedClass<TextPart>()('Text', {
  text: Schema.String
}) {}

export class ImagePart extends Schema.TaggedClass<ImagePart>()('Image', {
  data: Schema.String,
  mimeType: Schema.String
}) {}

export class AudioPart extends Schema.TaggedClass<AudioPart>()('Audio', {
  data: Schema.String,
  format: Schema.Literals(['pcm16', 'wav', 'mp3', 'opus'])
}) {}

export const ContentPart = Schema.Union([TextPart, ImagePart, AudioPart])
export type ContentPart = typeof ContentPart.Type

export const Content = Schema.Union([Schema.String, Schema.Array(ContentPart)])
export type Content = typeof Content.Type

export const contentPartText = (part: ContentPart) => {
  switch (part._tag) {
    case 'Text':
      return part.text
    case 'Image':
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
    case 'Audio':
      return 'Audio'
  }
}

export const contentText = (content: Content) =>
  typeof content === 'string' ? content : content.map(contentPartText).join('')

export const contentPreview = (content: Content) =>
  typeof content === 'string' ? content : content.map(contentPartPreview).join(', ')

export const contentParts = (content: Content): ReadonlyArray<ContentPart> =>
  typeof content === 'string' ? [TextPart.make({ text: content })] : content

export const isContentEmpty = (content: Content) =>
  typeof content === 'string'
    ? content.length === 0
    : content.length === 0 || content.every(part => part._tag === 'Text' && part.text.length === 0)

export const appendTextToContent = (content: Content, text: string): Content => {
  if (typeof content === 'string') {
    return `${content}${text}`
  }

  const last = content[content.length - 1]

  if (last?._tag !== 'Text') {
    return [...content, TextPart.make({ text })]
  }

  return content.map((part, index) =>
    index === content.length - 1 && part._tag === 'Text'
      ? TextPart.make({ text: `${part.text}${text}` })
      : part
  )
}
