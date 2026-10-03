import { DateTime, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { ToolError } from '@yolk-sdk/agent/loop'
import { toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  KnowledgeLookupOutput,
  KnowledgeManageOutput,
  makeKnowledgeLookupTool,
  makeKnowledgeManageTool
} from '../src/agent.ts'
import { KnowledgeDocumentId, type KnowledgeDocument } from '../src/documents.ts'

const document: KnowledgeDocument = {
  id: KnowledgeDocumentId.make('doc_1'),
  slug: 'project.memory',
  title: 'Project memory',
  purpose: 'Answer project questions.',
  origin: 'test',
  content: 'durable fact',
  status: 'ready',
  availability: 'searchable',
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(1_000)
}

const encodedDocument = {
  id: 'doc_1',
  slug: 'project.memory',
  title: 'Project memory',
  purpose: 'Answer project questions.',
  origin: 'test',
  content: 'durable fact',
  status: 'ready',
  availability: 'searchable',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:01.000Z'
}

const call = (name: string, params: unknown) => ToolCall.make({ id: 'call_1', name, params })

const lookupTool = makeKnowledgeLookupTool<undefined>({
  search: () =>
    Effect.succeed([
      { document, score: 0.9, context: [{ content: 'nearby' }] },
      { document: { ...document, reviewedAt: DateTime.makeUnsafe(2_000) } }
    ]),
  get: () => Effect.succeed(document)
})

const saved = { id: 'doc_1', slug: 'project.memory', title: 'Project memory' }

const manageTool = makeKnowledgeManageTool<undefined>({
  upsert: () => Effect.succeed(saved),
  setAvailability: () => Effect.succeed(saved),
  renameSlug: () => Effect.succeed(saved),
  delete: () => Effect.succeed(saved)
})

describe('knowledge tool output', () => {
  it('declares output schemas for code mode', () => {
    expect(lookupTool.def.outputSchema).toEqual(toolJsonSchemaFromSchema(KnowledgeLookupOutput))
    expect(manageTool.def.outputSchema).toEqual(toolJsonSchemaFromSchema(KnowledgeManageOutput))
  })

  it.effect('returns the JSON encoding of search results and keeps the text', () =>
    Effect.gen(function* () {
      const result = yield* lookupTool.execute({
        context: undefined,
        call: call('knowledge_lookup', { operation: 'search', query: 'docs' })
      })

      expect(result.structuredContent).toStrictEqual({
        operation: 'search',
        results: [
          { document: encodedDocument, score: 0.9, context: [{ content: 'nearby' }] },
          { document: { ...encodedDocument, reviewedAt: '1970-01-01T00:00:02.000Z' } }
        ]
      })
      expect(result.content).toContain('## Project memory\ndocument_id: doc_1')
      expect(result.content).toContain('score: 0.9\n\nnearby')
    })
  )

  it.effect('returns the JSON encoding of a fetched document', () =>
    Effect.gen(function* () {
      const result = yield* lookupTool.execute({
        context: undefined,
        call: call('knowledge_lookup', { operation: 'get', id: 'doc_1' })
      })

      expect(result.structuredContent).toStrictEqual({
        operation: 'get',
        document: encodedDocument
      })
      expect(result.content).toContain('# Project memory\ndocument_id: doc_1')
    })
  )

  it.effect('fails with a safe execution error when a handler result does not encode', () =>
    Effect.gen(function* () {
      const tool = makeKnowledgeLookupTool<undefined>({
        search: () => Effect.succeed([]),
        get: () => Effect.succeed({ ...document, title: '' })
      })

      const failure = yield* Effect.flip(
        tool.execute({
          context: undefined,
          call: call('knowledge_lookup', { operation: 'get', id: 'doc_1' })
        })
      )

      expect(failure).toBeInstanceOf(ToolError)
      expect(failure).toMatchObject({
        cause: 'execution',
        message: 'knowledge_lookup produced a result that does not match its output schema.'
      })
    })
  )

  it.effect('returns the operation and saved document for every manage operation', () =>
    Effect.gen(function* () {
      const target = { slug: 'project.memory' }

      const calls = [
        {
          operation: 'upsert',
          target,
          title: 'Project memory',
          purpose: 'p',
          origin: 'o',
          content: 'c',
          availability: 'pinned'
        },
        { operation: 'set_availability', target, availability: 'archived' },
        { operation: 'rename_slug', target, nextSlug: 'project.notes' },
        { operation: 'delete', target }
      ]

      for (const params of calls) {
        const result = yield* manageTool.execute({
          context: undefined,
          call: call('knowledge_manage', params)
        })

        expect(result.structuredContent).toStrictEqual({
          operation: params.operation,
          document: saved
        })
        expect(result.content).toContain('title: Project memory\nslug: project.memory')
      }
    })
  )
})
