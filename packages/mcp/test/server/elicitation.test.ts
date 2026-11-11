import { Effect, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  callRemoteMcpServerToolResumable,
  resumeRemoteMcpServerToolCall,
  type McpRemoteServerConfig
} from '../../src/client'
import {
  approvalInputKey,
  changedPromptMessage,
  makeMcpServerElicitedTool,
  makeMcpToolServer,
  mcpFormBoolean,
  mcpFormChoice,
  mcpFormMultiSelect,
  mcpServerForm,
  mcpServerMaxPromptBytes,
  oversizedPromptMessage
} from '../../src/server'
import {
  CallResult,
  InputRequired,
  jsonObject,
  key,
  modernRequest,
  respond,
  type ToolServer
} from './mcp-requests'

const reviewForm = mcpServerForm({
  selected: mcpFormMultiSelect({
    title: 'Calls to apply',
    options: [
      { value: 's1', title: '1. Post "Ship it"' },
      { value: 's2', title: '2. Post "Done"' },
      { value: 's3', title: '3. Delete draft' }
    ],
    default: ['s1', 's2', 's3']
  }),
  notify: mcpFormBoolean({ title: 'Notify the channel', default: false }),
  urgency: mcpFormChoice({
    title: 'Urgency',
    options: [
      { value: 'low', title: 'Low' },
      { value: 'high', title: 'High' }
    ]
  })
})

describe('MCP server forms', () => {
  it('describes each field as the 2026-07-28 restricted schema, every field required', () => {
    expect(reviewForm.requestedSchema).toEqual({
      type: 'object',
      properties: {
        selected: {
          type: 'array',
          title: 'Calls to apply',
          minItems: 1,
          items: {
            anyOf: [
              { const: 's1', title: '1. Post "Ship it"' },
              { const: 's2', title: '2. Post "Done"' },
              { const: 's3', title: '3. Delete draft' }
            ]
          },
          default: ['s1', 's2', 's3']
        },
        notify: { type: 'boolean', title: 'Notify the channel', default: false },
        urgency: {
          type: 'string',
          title: 'Urgency',
          oneOf: [
            { const: 'low', title: 'Low' },
            { const: 'high', title: 'High' }
          ]
        }
      },
      required: ['selected', 'notify', 'urgency']
    })

    expect(mcpServerForm({}).requestedSchema).toEqual({ type: 'object', properties: {} })
  })

  it('decodes a fitting answer and rejects every answer the form does not offer', () => {
    expect(reviewForm.decode({ selected: ['s1', 's3'], notify: true, urgency: 'high' })).toEqual(
      Option.some({ selected: ['s1', 's3'], notify: true, urgency: 'high' })
    )

    const misfits: ReadonlyArray<unknown> = [
      { selected: [], notify: true, urgency: 'low' },
      { selected: ['s1', 's1'], notify: true, urgency: 'low' },
      { selected: ['s9'], notify: true, urgency: 'low' },
      { selected: 's1', notify: true, urgency: 'low' },
      { selected: ['s1'], notify: 'yes', urgency: 'low' },
      { selected: ['s1'], notify: true, urgency: 'urgent' },
      { selected: ['s1'], notify: true },
      undefined
    ]

    for (const misfit of misfits) expect(reviewForm.decode(misfit)).toEqual(Option.none())

    const capped = mcpServerForm({
      picks: mcpFormMultiSelect({
        title: 'Picks',
        options: [
          { value: 'a', title: 'A' },
          { value: 'b', title: 'B' }
        ],
        maxItems: 1
      })
    })

    expect(capped.requestedSchema).toMatchObject({ properties: { picks: { maxItems: 1 } } })
    expect(capped.decode({ picks: ['a', 'b'] })).toEqual(Option.none())
    expect(mcpServerForm({}).decode({})).toEqual(Option.some({}))
  })
})

type Answered = {
  readonly elicitationId: string
  readonly selected: ReadonlyArray<string>
}

/**
 * A server with one elicited tool `apply` that asks which staged calls to apply. `title` reads the
 * prompt's current first title, so a test can change the prompt between rounds.
 */
const reviewServer = (input: {
  readonly runs: Ref.Ref<ReadonlyArray<Answered>>
  readonly title?: Ref.Ref<string>
  readonly message?: string
}) =>
  makeMcpToolServer({
    name: 'review-server',
    version: '0',
    approvals: { key, principal: 'token-1' },
    tools: [
      makeMcpServerElicitedTool({
        def: ToolDef.make({
          name: 'apply',
          description: 'Apply staged calls',
          parameters: { type: 'object', properties: { planId: { type: 'string' } } }
        }),
        elicit: () =>
          Effect.gen(function* () {
            const first = input.title === undefined ? 'Post' : yield* Ref.get(input.title)

            return {
              message: input.message ?? 'Apply which calls?',
              form: mcpServerForm({
                selected: mcpFormMultiSelect({
                  title: 'Calls',
                  options: [
                    { value: 's1', title: first },
                    { value: 's2', title: 'Delete' }
                  ],
                  default: ['s1', 's2']
                })
              })
            }
          }),
        execute: (call, answered) =>
          Ref.update(input.runs, runs => [
            ...runs,
            { elicitationId: answered.elicitationId, selected: answered.answer.selected }
          ]).pipe(
            Effect.as(
              ToolResult.make({
                toolCallId: call.id,
                content: `applied ${answered.answer.selected.join(',')}`
              })
            )
          )
      })
    ]
  })

const callApply = (input: {
  readonly id?: number
  readonly retry?: { readonly requestState: string; readonly response: Schema.JsonObject }
}) =>
  modernRequest({
    method: 'tools/call',
    id: input.id ?? 1,
    toolName: 'apply',
    params: jsonObject(
      input.retry === undefined
        ? { name: 'apply', arguments: { planId: 'p1' } }
        : {
            name: 'apply',
            arguments: { planId: 'p1' },
            requestState: input.retry.requestState,
            inputResponses: { [approvalInputKey]: input.retry.response }
          }
    )
  })

const ask = (server: ToolServer, id = 1) =>
  respond(server, callApply({ id })).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)))

const accept = (content: Schema.JsonObject) => ({ action: 'accept', content })

describe('MCP elicited tools', () => {
  it.effect('asks with the form, then runs the accepted answer, decoded', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<Answered>>([])
      const server = reviewServer({ runs })
      const pause = yield* ask(server)

      expect(pause.result.inputRequests[approvalInputKey]?.params).toMatchObject({
        mode: 'form',
        message: 'Apply which calls?',
        requestedSchema: {
          type: 'object',
          properties: { selected: { type: 'array', default: ['s1', 's2'] } },
          required: ['selected']
        }
      })
      expect(yield* Ref.get(runs)).toEqual([])

      const result = yield* respond(
        server,
        callApply({
          id: 2,
          retry: {
            requestState: pause.result.requestState,
            response: accept({ selected: ['s2'] })
          }
        })
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)))

      expect(result.result.content).toEqual([{ type: 'text', text: 'applied s2' }])

      const [run] = yield* Ref.get(runs)

      expect(run?.selected).toEqual(['s2'])
      expect(run?.elicitationId).toMatch(/^[0-9a-f-]{36}$/u)
    })
  )

  it.effect('asks again, running nothing, when the accepted answer does not fit the form', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<Answered>>([])
      const server = reviewServer({ runs })
      const pause = yield* ask(server)

      const misfits: ReadonlyArray<Schema.JsonObject> = [
        {},
        { selected: [] },
        { selected: ['s9'] },
        { selected: ['s1', 's1'] }
      ]

      for (const content of misfits) {
        const again = yield* respond(
          server,
          callApply({
            id: 2,
            retry: { requestState: pause.result.requestState, response: accept(content) }
          })
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)))

        expect(again.result.requestState).not.toBe(pause.result.requestState)
      }

      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('refuses an accepted answer to a prompt that changed since it was shown', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<Answered>>([])
      const title = yield* Ref.make('Post "Ship it"')
      const server = reviewServer({ runs, title })
      const pause = yield* ask(server)

      // The item behind option s1 changed before the user answered.
      yield* Ref.set(title, 'Post "Delete everything"')

      const result = yield* respond(
        server,
        callApply({
          id: 2,
          retry: { requestState: pause.result.requestState, response: accept({ selected: ['s1'] }) }
        })
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)))

      expect(result.result).toEqual({
        content: [{ type: 'text', text: changedPromptMessage }],
        isError: true
      })
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('refuses a prompt too large to show, signing nothing', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<Answered>>([])
      const server = reviewServer({ runs, message: 'x'.repeat(mcpServerMaxPromptBytes) })

      const result = yield* respond(server, callApply({})).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CallResult))
      )

      expect(result.result).toEqual({
        content: [{ type: 'text', text: oversizedPromptMessage }],
        isError: true
      })
    })
  )

  it.effect('is never offered on the header-less JSON path', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<Answered>>([])

      const listed = yield* respond(
        reviewServer({ runs }),
        new Request('https://example.com/mcp', {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        })
      )

      expect(listed).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    })
  )
})

/** The real `@yolk-sdk/mcp/client` resumable functions answering a multi-select, in-process. */
describe('MCP elicited tools through the Yolk client', () => {
  it.effect('pauses with the form and completes a resume that picks a subset', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<Answered>>([])
      const server = reviewServer({ runs })

      const layer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(request =>
          Effect.gen(function* () {
            const body = Predicate.isTagged(request.body, 'Uint8Array')
              ? new TextDecoder().decode(request.body.body)
              : undefined

            const response = yield* server.handleHttpRequest(
              new Request(request.url, { method: request.method, headers: request.headers, body })
            )

            return HttpClientResponse.fromWeb(request, response)
          })
        )
      )

      const config: McpRemoteServerConfig = {
        name: 'review',
        type: 'remote',
        url: 'https://example.com/mcp'
      }

      const call = {
        config,
        mcpToolName: 'apply',
        toolCallId: 'call_1',
        params: { planId: 'p1' },
        options: { elicitation: { form: true } }
      } as const

      const first = yield* callRemoteMcpServerToolResumable(call).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired')) {
        return expect.fail(`Expected InputRequired, got ${first._tag}`)
      }

      const resumed = yield* resumeRemoteMcpServerToolCall({
        ...call,
        inputRequired: first.inputRequired,
        responses: { [approvalInputKey]: { action: 'accept', content: { selected: ['s1'] } } }
      }).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(resumed, 'Complete')) {
        return expect.fail(`Expected Complete, got ${resumed._tag}`)
      }

      expect(resumed.result.content).toBe('applied s1')
      expect((yield* Ref.get(runs)).map(run => run.selected)).toEqual([['s1']])
    })
  )
})
