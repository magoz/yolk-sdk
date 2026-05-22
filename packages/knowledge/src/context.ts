import { Array as Arr } from 'effect'
import type { KnowledgeRecord } from './records.ts'
import type { KnowledgeRepresentation } from './representations.ts'

export type KnowledgeContextItem = {
  readonly record: KnowledgeRecord
  readonly representation?: KnowledgeRepresentation
}

export type BuildKnowledgeContextInput = {
  readonly items: ReadonlyArray<KnowledgeContextItem>
  readonly maxCharacters: number
}

const truncationMarker = '\n\n[truncated: pinned knowledge exceeded context budget]'

const recordHeader = (record: KnowledgeRecord) =>
  `## ${record.title}\nrole: ${record.role}\nstatus: ${record.status}\ncontext: ${record.contextPolicy}`

const itemBody = (item: KnowledgeContextItem) => {
  const representationText = item.representation?.summary ?? item.representation?.contentText
  return [recordHeader(item.record), item.record.summary, representationText]
    .filter(section => section !== undefined && section.trim().length > 0)
    .join('\n')
}

export const buildKnowledgeContext = (input: BuildKnowledgeContextInput) => {
  const sections = Arr.map(input.items, itemBody).filter(section => section.trim().length > 0)
  const header = '# Pinned knowledge\nUse this durable user knowledge as high-priority context. Cite knowledge records when relevant.'
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
