import { Array as Arr, Predicate } from 'effect'
import {
  DocumentPart,
  ImagePart,
  TextPart,
  inlineBase64Source,
  type Content
} from '@yolk-sdk/agent/protocol'
import type {
  AgentComposerFailedAttachment,
  AgentComposerReadyDocumentAttachment,
  AgentComposerReadyImageAttachment
} from './agent-composer'

export type ReadyImageAttachment = AgentComposerReadyImageAttachment & {
  readonly data: string
}

export type ReadyDocumentAttachment = AgentComposerReadyDocumentAttachment & {
  readonly data: string
}

export type ReadyAttachment = ReadyImageAttachment | ReadyDocumentAttachment

export type FailedAttachment = AgentComposerFailedAttachment & {
  readonly file: File
}

export type AgentAttachment = ReadyAttachment | FailedAttachment

export const isReadyAttachment = (attachment: AgentAttachment): attachment is ReadyAttachment =>
  Predicate.isTagged(attachment, 'Ready')

export const isReadyImageAttachment = (
  attachment: AgentAttachment
): attachment is ReadyImageAttachment =>
  Predicate.isTagged(attachment, 'Ready') && attachment.kind === 'image'

export const isReadyDocumentAttachment = (
  attachment: AgentAttachment
): attachment is ReadyDocumentAttachment =>
  Predicate.isTagged(attachment, 'Ready') && attachment.kind === 'document'

export const isFailedAttachment = (attachment: AgentAttachment): attachment is FailedAttachment =>
  Predicate.isTagged(attachment, 'Failed')

export const contentFromInput = (
  input: string,
  attachments: ReadonlyArray<AgentAttachment>
): Content => {
  const text = input.trim()
  const readyAttachments = Arr.filter(attachments, isReadyAttachment)

  if (readyAttachments.length === 0) {
    return text
  }

  const mediaParts = Arr.map(readyAttachments, attachment => {
    switch (attachment.kind) {
      case 'image':
        return ImagePart.make({
          source: inlineBase64Source(attachment.data),
          mimeType: attachment.mimeType
        })
      case 'document':
        return DocumentPart.make({
          source: inlineBase64Source(attachment.data),
          mimeType: attachment.mimeType,
          filename: attachment.name
        })
    }
  })

  return text.length > 0 ? [TextPart.make({ text }), ...mediaParts] : mediaParts
}
