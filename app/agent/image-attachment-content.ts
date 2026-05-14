import { Array as Arr } from 'effect'
import { ImagePart, TextPart, type Content } from '@yolk/agent/protocol'
import type {
  AgentComposerFailedImageAttachment,
  AgentComposerImageAttachment
} from './agent-composer'

export type ReadyImageAttachment = AgentComposerImageAttachment & {
  readonly data: string
}

export type FailedImageAttachment = AgentComposerFailedImageAttachment & {
  readonly file: File
}

export type ImageAttachment = ReadyImageAttachment | FailedImageAttachment

export const isReadyImageAttachment = (
  imageAttachment: ImageAttachment
): imageAttachment is ReadyImageAttachment => imageAttachment._tag === 'Ready'

export const isFailedImageAttachment = (
  imageAttachment: ImageAttachment
): imageAttachment is FailedImageAttachment => imageAttachment._tag === 'Failed'

export const contentFromInput = (
  input: string,
  imageAttachments: ReadonlyArray<ImageAttachment>
): Content => {
  const text = input.trim()

  const readyAttachments = Arr.filter(imageAttachments, isReadyImageAttachment)

  if (readyAttachments.length === 0) {
    return text
  }

  const imageParts = Arr.map(readyAttachments, imageAttachment =>
    ImagePart.make({ data: imageAttachment.data, mimeType: imageAttachment.mimeType })
  )

  return text.length > 0 ? [TextPart.make({ text }), ...imageParts] : imageParts
}
