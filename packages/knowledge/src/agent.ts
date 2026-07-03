import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { makeTool, type ToolRegistration } from '@yolk-sdk/agent/tools'
import {
  KnowledgeAvailabilitySchema,
  NonEmptyTrimmedString,
  type KnowledgeAvailability,
  type KnowledgeDocument
} from './documents.ts'

const OptionalNonEmptyTrimmedString = Schema.optional(Schema.NullOr(NonEmptyTrimmedString))
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number))

const KnowledgeTargetParamsSchema = Schema.Struct({
  slug: NonEmptyTrimmedString,
  scope: OptionalNonEmptyTrimmedString
})

const KnowledgeLookupParams = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('search'),
    query: NonEmptyTrimmedString,
    limit: OptionalNumber,
    minScore: OptionalNumber,
    contextChunks: OptionalNumber
  }),
  Schema.Struct({
    operation: Schema.Literal('get'),
    id: OptionalNonEmptyTrimmedString,
    target: Schema.optional(Schema.NullOr(KnowledgeTargetParamsSchema))
  })
])

const KnowledgeManageParams = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('upsert'),
    target: KnowledgeTargetParamsSchema,
    title: NonEmptyTrimmedString,
    purpose: NonEmptyTrimmedString,
    origin: NonEmptyTrimmedString,
    content: NonEmptyTrimmedString,
    availability: KnowledgeAvailabilitySchema
  }),
  Schema.Struct({
    operation: Schema.Literal('set_availability'),
    target: KnowledgeTargetParamsSchema,
    availability: KnowledgeAvailabilitySchema
  }),
  Schema.Struct({
    operation: Schema.Literal('rename_slug'),
    target: KnowledgeTargetParamsSchema,
    nextSlug: NonEmptyTrimmedString
  }),
  Schema.Struct({
    operation: Schema.Literal('delete'),
    target: KnowledgeTargetParamsSchema
  })
])

type KnowledgeTargetParams = typeof KnowledgeTargetParamsSchema.Type
type KnowledgeLookupParams = typeof KnowledgeLookupParams.Type
type KnowledgeManageParams = typeof KnowledgeManageParams.Type

export type KnowledgeTarget = {
  readonly slug: string
  readonly scope?: string
}

export type KnowledgeLookupResult = {
  readonly document: KnowledgeDocument
  readonly score?: number
  readonly context?: ReadonlyArray<{ readonly content: string }>
}

export type KnowledgeSavedDocument = {
  readonly id: string
  readonly slug: string
  readonly title: string
}

export type KnowledgeLookupHandlers<Context> = {
  readonly search: (input: {
    readonly context: Context
    readonly query: string
    readonly limit?: number
    readonly minScore?: number
    readonly contextChunks?: number
  }) => Effect.Effect<ReadonlyArray<KnowledgeLookupResult>, ToolError>
  readonly get: (input: {
    readonly context: Context
    readonly id?: string
    readonly target?: KnowledgeTarget
  }) => Effect.Effect<KnowledgeDocument, ToolError>
}

export type KnowledgeManageHandlers<Context> = {
  readonly upsert: (input: {
    readonly context: Context
    readonly target: KnowledgeTarget
    readonly title: string
    readonly purpose: string
    readonly origin: string
    readonly content: string
    readonly availability: KnowledgeAvailability
  }) => Effect.Effect<KnowledgeSavedDocument, ToolError>
  readonly setAvailability: (input: {
    readonly context: Context
    readonly target: KnowledgeTarget
    readonly availability: KnowledgeAvailability
  }) => Effect.Effect<KnowledgeSavedDocument, ToolError>
  readonly renameSlug: (input: {
    readonly context: Context
    readonly target: KnowledgeTarget
    readonly nextSlug: string
  }) => Effect.Effect<KnowledgeSavedDocument, ToolError>
  readonly delete: (input: {
    readonly context: Context
    readonly target: KnowledgeTarget
  }) => Effect.Effect<KnowledgeSavedDocument, ToolError>
}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const optionalValue = <Value>(value: Value | null | undefined) => value ?? undefined

const targetFromParams = (target: KnowledgeTargetParams): KnowledgeTarget =>
  target.scope === null || target.scope === undefined
    ? { slug: target.slug }
    : { slug: target.slug, scope: target.scope }

const optionalTargetFromParams = (target: KnowledgeTargetParams | null | undefined) =>
  target === null || target === undefined ? undefined : targetFromParams(target)

const formatDocument = (document: KnowledgeDocument) =>
  [
    `# ${document.title}`,
    `document_id: ${document.id}`,
    `slug: ${document.slug}`,
    `purpose: ${document.purpose}`,
    `origin: ${document.origin}`,
    `availability: ${document.availability}`,
    `status: ${document.status}`,
    '',
    document.content
  ].join('\n')

const formatSearchResults = (results: ReadonlyArray<KnowledgeLookupResult>) =>
  results.length === 0
    ? 'No knowledge matches found.'
    : results
        .map(result =>
          [
            `## ${result.document.title}`,
            `document_id: ${result.document.id}`,
            `slug: ${result.document.slug}`,
            `purpose: ${result.document.purpose}`,
            `origin: ${result.document.origin}`,
            `availability: ${result.document.availability}`,
            result.score === undefined ? undefined : `score: ${result.score}`,
            '',
            result.context?.map(chunk => chunk.content).join('\n\n') ?? result.document.content
          ]
            .filter(line => line !== undefined)
            .join('\n')
        )
        .join('\n\n')

const formatSaved = (verb: string, document: KnowledgeSavedDocument) =>
  [verb, `title: ${document.title}`, `slug: ${document.slug}`, `document_id: ${document.id}`].join(
    '\n'
  )

export const makeKnowledgeLookupTool = <Context>(
  handlers: KnowledgeLookupHandlers<Context>,
  options: { readonly name?: string; readonly description?: string } = {}
): ToolRegistration<Context> => {
  const name = options.name ?? 'knowledge_lookup'

  return makeTool({
    name,
    description:
      options.description ??
      'Look up durable knowledge. Search for semantic discovery; get when document_id or slug is known.',
    parameters: KnowledgeLookupParams,
    access: 'read',
    invalidParamsMessage: error => `Invalid knowledge lookup arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        if (params.operation === 'search') {
          const results = yield* handlers.search({
            context,
            query: params.query,
            limit: optionalValue(params.limit),
            minScore: optionalValue(params.minScore),
            contextChunks: optionalValue(params.contextChunks)
          })

          return ToolResult.make({ toolCallId: call.id, content: formatSearchResults(results) })
        }

        const document = yield* handlers.get({
          context,
          id: optionalValue(params.id),
          target: optionalTargetFromParams(params.target)
        })
        return ToolResult.make({ toolCallId: call.id, content: formatDocument(document) })
      })
  })
}

export const makeKnowledgeManageTool = <Context>(
  handlers: KnowledgeManageHandlers<Context>,
  options: { readonly name?: string; readonly description?: string } = {}
): ToolRegistration<Context> => {
  const name = options.name ?? 'knowledge_manage'

  return makeTool({
    name,
    description:
      options.description ??
      'Create, replace, pin, archive, rename, or delete durable knowledge. Use only when explicitly asked.',
    parameters: KnowledgeManageParams,
    access: 'write',
    invalidParamsMessage: error => `Invalid knowledge manage arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        switch (params.operation) {
          case 'upsert': {
            const document = yield* handlers.upsert({
              context,
              target: targetFromParams(params.target),
              title: params.title,
              purpose: params.purpose,
              origin: params.origin,
              content: params.content,
              availability: params.availability
            })
            return ToolResult.make({
              toolCallId: call.id,
              content: formatSaved('Knowledge upserted', document)
            })
          }
          case 'set_availability': {
            const document = yield* handlers.setAvailability({
              context,
              target: targetFromParams(params.target),
              availability: params.availability
            })
            return ToolResult.make({
              toolCallId: call.id,
              content: formatSaved('Knowledge availability updated', document)
            })
          }
          case 'rename_slug': {
            const document = yield* handlers.renameSlug({
              context,
              target: targetFromParams(params.target),
              nextSlug: params.nextSlug
            })
            return ToolResult.make({
              toolCallId: call.id,
              content: formatSaved('Knowledge slug renamed', document)
            })
          }
          case 'delete': {
            const document = yield* handlers.delete({
              context,
              target: targetFromParams(params.target)
            })
            return ToolResult.make({
              toolCallId: call.id,
              content: formatSaved('Knowledge deleted', document)
            })
          }
        }

        return yield* Effect.fail(
          new ToolError({
            tool: call.name,
            message: 'Unsupported knowledge operation',
            cause: 'validation'
          })
        )
      })
  })
}
