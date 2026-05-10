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
