import { ImagePart, TextPart, type Content } from '@yolk/protocol'
import type { AgentComposerImageAttachment } from './agent-composer'

export type ImageAttachment = AgentComposerImageAttachment & {
  readonly data: string
}

export const contentFromInput = (
  input: string,
  imageAttachment: ImageAttachment | null
): Content => {
  const text = input.trim()

  if (imageAttachment === null) {
    return text
  }

  return text.length > 0
    ? [
        TextPart.make({ text }),
        ImagePart.make({ data: imageAttachment.data, mimeType: imageAttachment.mimeType })
      ]
    : [ImagePart.make({ data: imageAttachment.data, mimeType: imageAttachment.mimeType })]
}
