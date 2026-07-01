import { Array as Arr } from 'effect'
import type { KnowledgeDocument } from './documents.ts'

export type BuildKnowledgeContextInput = {
  readonly documents: ReadonlyArray<KnowledgeDocument>
  readonly maxCharacters: number
}

const truncationMarker = '\n\n[truncated: pinned knowledge exceeded context budget]'

const documentHeader = (document: KnowledgeDocument) =>
  [
    `## ${document.title}`,
    `slug: ${document.slug}`,
    `purpose: ${document.purpose}`,
    `origin: ${document.origin}`,
    `status: ${document.status}`,
    `availability: ${document.availability}`,
    document.reviewedAt === undefined ? undefined : `reviewed_at: ${document.reviewedAt.toString()}`
  ]
    .filter(line => line !== undefined && line.trim().length > 0)
    .join('\n')

const documentBody = (document: KnowledgeDocument) =>
  [documentHeader(document), document.summary, document.content]
    .filter(section => section !== undefined && section.trim().length > 0)
    .join('\n')

export const buildKnowledgeContext = (input: BuildKnowledgeContextInput) => {
  const sections = Arr.map(input.documents, documentBody).filter(section => section.trim().length > 0)
  const header = '# Pinned knowledge\nUse this durable knowledge as high-priority context.'
  const body = sections.join('\n\n')
  const context = body.length === 0 ? '' : `${header}\n\n${body}`

  if (context.length <= input.maxCharacters) {
    return context
  }

  if (input.maxCharacters <= truncationMarker.length) {
    return context.slice(0, input.maxCharacters).trimEnd()
  }

  return `${context.slice(0, input.maxCharacters - truncationMarker.length).trimEnd()}${truncationMarker}`
}
