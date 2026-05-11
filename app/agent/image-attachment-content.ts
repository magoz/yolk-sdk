import { ImagePart, TextPart, type Content } from '@yolk/protocol'
import type { AgentComposerImageAttachment } from './agent-composer'

export type ImageAttachment = AgentComposerImageAttachment & {
  readonly id: string
  readonly data: string
}

export const contentFromInput = (
  input: string,
  imageAttachments: ReadonlyArray<ImageAttachment>
): Content => {
  const text = input.trim()

  if (imageAttachments.length === 0) {
    return text
  }

  const imageParts = imageAttachments.map(imageAttachment =>
    ImagePart.make({ data: imageAttachment.data, mimeType: imageAttachment.mimeType })
  )

  return text.length > 0 ? [TextPart.make({ text }), ...imageParts] : imageParts
}
