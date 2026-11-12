import { Effect, Layer, Predicate, Ref } from 'effect'
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
  approvalForm,
  approvalInputKey,
  changedPromptMessage,
  declinedApprovalMessage,
  declaresFormElicitation,
  staleApprovalMessage,
  makeMcpToolServer,
  type McpServerApprovalOptions,
  type McpServerTool
} from '../../src/server'
import {
  CallResult,
  decodeJson,
  formCapabilities,
  InputRequired,
  jsonObject,
  key,
  modernRequest,
  respond,
  type ToolServer
} from './mcp-requests'

/** A server with one approval tool `send` that records each `approvalId` it ran with. */
const approvalServer = (options: {
  readonly runs: Ref.Ref<ReadonlyArray<string>>
  readonly approvals?: McpServerApprovalOptions
  readonly greeting?: Ref.Ref<string>
}) => {
  const { greeting } = options

  const send: McpServerTool = {
    def: ToolDef.make({
      name: 'send',
      description: 'Send a message',
      parameters: { type: 'object', properties: { to: { type: 'string' } } }
    }),
    annotations: { title: 'Send', readOnlyHint: false, destructiveHint: false },
    approval: {
      message: call =>
        Effect.map(
          greeting === undefined ? Effect.succeed('') : Ref.get(greeting),
          prefix => `${prefix}Send to ${JSON.stringify(call.params)}?`
        )
    },
    execute: (call, approved) =>
      Ref.update(options.runs, runs => [...runs, approved.approvalId]).pipe(
        Effect.as(ToolResult.make({ toolCallId: call.id, content: 'sent' }))
      )
  }

  const echo: McpServerTool = {
    def: ToolDef.make({ name: 'echo', description: 'Echo', parameters: { type: 'object' } }),
    annotations: { readOnlyHint: true },
    execute: call => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'echo' }))
  }

  return options.approvals === undefined
    ? makeMcpToolServer({ name: 'approval-server', version: '0', tools: [echo, send] })
    : makeMcpToolServer({
        name: 'approval-server',
        version: '0',
        tools: [echo, send],
        approvals: options.approvals
      })
}

const configured = { key, principal: 'token-1' } satisfies McpServerApprovalOptions

const callSend = (input: {
  readonly id?: number
  readonly args?: Schema.JsonObject
  readonly retry?: { readonly requestState: string; readonly response?: Schema.JsonObject }
  readonly capabilities?: Schema.JsonObject
}) => {
  const call = { name: 'send', arguments: input.args ?? { to: 'ada' } }
  const retry = input.retry

  const params =
    retry === undefined
      ? call
      : retry.response === undefined
        ? { ...call, requestState: retry.requestState }
        : {
            ...call,
            requestState: retry.requestState,
            inputResponses: { [approvalInputKey]: retry.response }
          }

  return modernRequest({
    method: 'tools/call',
    id: input.id ?? 1,
    toolName: 'send',
    capabilities: input.capabilities ?? formCapabilities,
    params: jsonObject(params)
  })
}

const ask = (server: ToolServer) =>
  respond(server, callSend({})).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)))

const callResult = (server: ToolServer, request: Request) =>
  respond(server, request).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)))

describe('MCP tool server approvals', () => {
  it.effect('lists approval tools with their annotations to 2026-07-28 clients only', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })

      const modern = yield* respond(server, modernRequest({ method: 'tools/list' }))

      expect(modern).toMatchObject({
        result: {
          tools: [
            { name: 'echo', annotations: { readOnlyHint: true } },
            {
              name: 'send',
              title: 'Send',
              annotations: { title: 'Send', readOnlyHint: false, destructiveHint: false }
            }
          ]
        }
      })

      const legacy = yield* respond(
        server,
        new Request('https://example.com/mcp', {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        })
      )

      expect(legacy).toEqual({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true }
            }
          ]
        }
      })
    })
  )

  it.effect('asks before the first call runs, then runs an accepted retry once per prompt', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })

      const pause = yield* ask(server)
      const request = pause.result.inputRequests[approvalInputKey]

      // One required choice, never an empty form: a client may accept an empty one unseen.
      expect(request?.params).toEqual({
        mode: 'form',
        message: 'Send to {"to":"ada"}?',
        requestedSchema: approvalForm.requestedSchema
      })
      expect(approvalForm.requestedSchema).toMatchObject({
        properties: { decision: { oneOf: [{ const: 'approve' }, { const: 'deny' }] } },
        required: ['decision']
      })
      expect(yield* Ref.get(runs)).toEqual([])

      const retry = {
        requestState: pause.result.requestState,
        response: { action: 'accept', content: { decision: 'approve' } }
      }

      const result = yield* callResult(server, callSend({ id: 2, retry }))

      expect(result.result.content).toEqual([{ type: 'text', text: 'sent' }])
      expect(result.result.isError).toBeUndefined()

      const [approvalId] = yield* Ref.get(runs)

      // A replayed accept runs again with the same approvalId: once-only is the host's job.
      yield* callResult(server, callSend({ id: 3, retry }))

      expect(yield* Ref.get(runs)).toEqual([approvalId, approvalId])

      const second = yield* ask(server)

      expect(second.result.requestState).not.toBe(pause.result.requestState)
    })
  )

  it.effect('runs nothing for a deny choice, or for an accept that carries no choice', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })
      const pause = yield* ask(server)

      const answer = (response: Schema.JsonObject) =>
        respond(
          server,
          callSend({ id: 2, retry: { requestState: pause.result.requestState, response } })
        )

      const denied = yield* answer({ action: 'accept', content: { decision: 'deny' } }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CallResult))
      )

      expect(denied.result).toEqual({
        content: [{ type: 'text', text: declinedApprovalMessage }],
        isError: true
      })

      // What a client that auto-accepts an empty form would send: not an approval, so it asks again.
      const again = yield* answer({ action: 'accept', content: {} }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(InputRequired))
      )

      expect(again.result.requestState).not.toBe(pause.result.requestState)
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('a decline or a cancel answers an error and runs nothing', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })
      const pause = yield* ask(server)

      for (const [action, text] of [
        ['decline', 'The user declined this call. Nothing ran.'],
        ['cancel', 'The user dismissed the approval request. Nothing ran.']
      ] as const) {
        const result = yield* callResult(
          server,
          callSend({
            id: 2,
            retry: { requestState: pause.result.requestState, response: { action } }
          })
        )

        expect(result.result).toEqual({ content: [{ type: 'text', text }], isError: true })
      }

      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('refuses an accept of a prompt whose message changed since it was shown', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const greeting = yield* Ref.make('')
      const server = approvalServer({ runs, approvals: configured, greeting })
      const pause = yield* ask(server)

      yield* Ref.set(greeting, 'Urgent! ')

      const result = yield* callResult(
        server,
        callSend({
          id: 2,
          retry: {
            requestState: pause.result.requestState,
            response: { action: 'accept', content: { decision: 'approve' } }
          }
        })
      )

      expect(result.result).toEqual({
        content: [{ type: 'text', text: changedPromptMessage }],
        isError: true
      })
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('asks again instead of running when the accept does not match a valid state', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })
      const pause = yield* ask(server)
      // A real approve: only the state's binding can make these ask again.
      const accept = { action: 'accept', content: { decision: 'approve' } }
      const state = pause.result.requestState

      const otherPrincipal = approvalServer({ runs, approvals: { key, principal: 'token-2' } })
      const otherKey = approvalServer({ runs, approvals: { ...configured, key: 'x'.repeat(32) } })

      const attempts: ReadonlyArray<readonly [ToolServer, Request]> = [
        // other arguments
        [
          server,
          callSend({ id: 2, args: { to: 'eve' }, retry: { requestState: state, response: accept } })
        ],
        // a tampered state
        [server, callSend({ id: 3, retry: { requestState: `${state}x`, response: accept } })],
        // no decision
        [server, callSend({ id: 4, retry: { requestState: state } })],
        // another principal, or another key
        [otherPrincipal, callSend({ id: 5, retry: { requestState: state, response: accept } })],
        [otherKey, callSend({ id: 6, retry: { requestState: state, response: accept } })]
      ]

      for (const [target, request] of attempts) {
        const again = yield* respond(target, request).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(InputRequired))
        )

        expect(again.result.requestState).not.toBe(state)
      }

      expect(yield* Ref.get(runs)).toEqual([])

      // The same accept with the right state, server and arguments runs.
      yield* callResult(
        server,
        callSend({ id: 7, retry: { requestState: state, response: accept } })
      )

      expect(yield* Ref.get(runs)).toHaveLength(1)
    })
  )

  it.effect('refuses, without running, a client that does not declare form elicitation', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })

      const undeclared: ReadonlyArray<Schema.JsonObject> = [{}, { elicitation: { url: {} } }]

      for (const capabilities of undeclared) {
        const result = yield* callResult(server, callSend({ capabilities }))

        expect(result.result.isError).toBe(true)
        expect(result.result.content[0]?.text).toContain('does not support form elicitation')
      }

      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('offers no approval tool without approvals, and refuses one on the JSON path', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const unconfigured = approvalServer({ runs })

      const listed = yield* respond(unconfigured, modernRequest({ method: 'tools/list' }))

      // An array matches only at its exact length: `send` is not listed.
      expect(listed).toMatchObject({ result: { tools: [{ name: 'echo' }] } })

      const json = yield* respond(
        approvalServer({ runs, approvals: configured }),
        new Request('https://example.com/mcp', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'send', arguments: {} }
          })
        })
      )

      expect(json).toMatchObject({ id: 7, result: { isError: true } })
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('answers an error when the approval key is too short', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: { key: 'short', principal: 'token-1' } })

      const result = yield* callResult(server, callSend({}))

      expect(result.result.isError).toBe(true)
      expect(result.result.content[0]?.text).toMatch(
        /^This tool needs the user's approval, which is misconfigured here \(.+\)\.$/u
      )

      const misconfigurations: ReadonlyArray<McpServerApprovalOptions> = [
        { key, principal: '' },
        { key, principal: 'token-1', ttlSeconds: 0 },
        { key, principal: 'token-1', ttlSeconds: 1.5 }
      ]

      for (const approvals of misconfigurations) {
        const misconfigured = yield* callResult(approvalServer({ runs, approvals }), callSend({}))

        expect(misconfigured.result.isError).toBe(true)
        expect(misconfigured.result.content[0]?.text).toContain('approvals.')
      }

      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('offers no approval tool to SDK-routed 2025-era requests', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const server = approvalServer({ runs, approvals: configured })

      const legacy = (body: Schema.JsonObject) =>
        Effect.gen(function* () {
          const response = yield* server.handleHttpRequest(
            new Request('https://example.com/mcp', {
              method: 'POST',
              headers: {
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                'mcp-protocol-version': '2025-06-18'
              },
              body: JSON.stringify(body)
            })
          )

          const text = yield* Effect.promise(() => response.text())

          return yield* Effect.forEach(
            text.split('\n').flatMap(line => (line.startsWith('data: ') ? [line.slice(6)] : [])),
            data => decodeJson(data)
          )
        })

      const listed = yield* legacy({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

      expect(listed).toMatchObject([{ id: 1, result: { tools: [{ name: 'echo' }] } }])

      const called = yield* legacy({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'send', arguments: { to: 'ada' } }
      })

      expect(called).toHaveLength(1)
      expect(called).not.toMatchObject([{ result: { content: [{ text: 'sent' }] } }])
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )

  it.effect('a tool that stopped asking runs no call that answers its old prompt', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const pause = yield* ask(approvalServer({ runs, approvals: configured }))

      // The host's policy changed: `send` now runs without asking.
      const direct = makeMcpToolServer({
        name: 'approval-server',
        version: '0',
        tools: [
          {
            def: ToolDef.make({
              name: 'send',
              description: 'Send',
              parameters: { type: 'object' }
            }),
            execute: call =>
              Ref.update(runs, current => [...current, call.id]).pipe(
                Effect.as(ToolResult.make({ toolCallId: call.id, content: 'sent' }))
              )
          }
        ],
        approvals: configured
      })

      for (const action of ['decline', 'accept'] as const) {
        const result = yield* callResult(
          direct,
          callSend({
            id: 2,
            retry: { requestState: pause.result.requestState, response: { action } }
          })
        )

        expect(result.result).toEqual({
          content: [{ type: 'text', text: staleApprovalMessage }],
          isError: true
        })
      }

      expect(yield* Ref.get(runs)).toEqual([])

      // A plain call still runs.
      yield* callResult(direct, callSend({ id: 3 }))

      expect(yield* Ref.get(runs)).toHaveLength(1)
    })
  )

  it.effect('asks again for a state minted for another tool or another server', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const pause = yield* ask(approvalServer({ runs, approvals: configured }))

      const accept = {
        requestState: pause.result.requestState,
        response: { action: 'accept', content: { decision: 'approve' } }
      }

      const renamed = (name: string, toolName: string) =>
        makeMcpToolServer({
          name,
          version: '0',
          tools: [
            {
              def: ToolDef.make({
                name: toolName,
                description: 'Send',
                parameters: { type: 'object' }
              }),
              approval: { message: () => Effect.succeed('Send?') },
              execute: (call, approved) =>
                Ref.update(runs, current => [...current, approved.approvalId]).pipe(
                  Effect.as(ToolResult.make({ toolCallId: call.id, content: 'sent' }))
                )
            }
          ],
          approvals: configured
        })

      const otherServer = yield* respond(
        renamed('another-server', 'send'),
        callSend({ id: 2, retry: accept })
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)))

      expect(otherServer.result.requestState).not.toBe(pause.result.requestState)

      const otherTool = yield* respond(
        renamed('approval-server', 'post'),
        modernRequest({
          method: 'tools/call',
          id: 3,
          toolName: 'post',
          capabilities: formCapabilities,
          params: jsonObject({
            name: 'post',
            arguments: { to: 'ada' },
            requestState: accept.requestState,
            inputResponses: { [approvalInputKey]: accept.response }
          })
        })
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)))

      expect(otherTool.result.requestState).not.toBe(pause.result.requestState)
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )
})

describe('declaresFormElicitation', () => {
  it('reads the 2026-07-28 envelope capabilities', () => {
    const envelope = (elicitation: unknown) => ({
      'io.modelcontextprotocol/clientCapabilities': elicitation === undefined ? {} : { elicitation }
    })

    expect(declaresFormElicitation(envelope({ form: {} }))).toBe(true)
    expect(declaresFormElicitation(envelope({}))).toBe(true)
    expect(declaresFormElicitation(envelope({ form: {}, url: {} }))).toBe(true)
    expect(declaresFormElicitation(envelope({ url: {} }))).toBe(false)
    expect(declaresFormElicitation(envelope(undefined))).toBe(false)
    expect(declaresFormElicitation(undefined)).toBe(false)
  })
})

/** The real `@yolk-sdk/mcp/client` resumable functions against this server, in-process. */
describe('MCP tool server approvals through the Yolk client', () => {
  const clientConfig: McpRemoteServerConfig = {
    name: 'o-o',
    type: 'remote',
    url: 'https://example.com/mcp'
  }

  const inProcess = (server: ToolServer) =>
    Layer.succeed(
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

  const call = {
    config: clientConfig,
    mcpToolName: 'send',
    toolCallId: 'call_1',
    params: { to: 'ada' },
    options: { elicitation: { form: true } }
  } satisfies Parameters<typeof callRemoteMcpServerToolResumable>[0]

  it.effect('pauses, then completes an accepted resume', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = inProcess(approvalServer({ runs, approvals: configured }))

      const first = yield* callRemoteMcpServerToolResumable(call).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired')) {
        return expect.fail(`Expected InputRequired, got ${first._tag}`)
      }

      expect(first.inputRequired.elicitations.map(elicitation => elicitation.key)).toEqual([
        approvalInputKey
      ])
      expect(yield* Ref.get(runs)).toEqual([])

      const resumed = yield* resumeRemoteMcpServerToolCall({
        ...call,
        inputRequired: first.inputRequired,
        responses: { [approvalInputKey]: { action: 'accept', content: { decision: 'approve' } } }
      }).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(resumed, 'Complete')) {
        return expect.fail(`Expected Complete, got ${resumed._tag}`)
      }

      expect(resumed.result.content).toBe('sent')
      expect(yield* Ref.get(runs)).toHaveLength(1)

      // A deny chosen in the form runs nothing.
      const second = yield* callRemoteMcpServerToolResumable(call).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(second, 'InputRequired')) {
        return expect.fail(`Expected InputRequired, got ${second._tag}`)
      }

      const denied = yield* resumeRemoteMcpServerToolCall({
        ...call,
        inputRequired: second.inputRequired,
        responses: { [approvalInputKey]: { action: 'accept', content: { decision: 'deny' } } }
      }).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(denied, 'Complete')) {
        return expect.fail(`Expected Complete, got ${denied._tag}`)
      }

      expect(denied.result.content).toBe(declinedApprovalMessage)
      expect(yield* Ref.get(runs)).toHaveLength(1)
    })
  )

  it.effect('a client that does not opt in gets an error result and nothing runs', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = inProcess(approvalServer({ runs, approvals: configured }))

      const outcome = yield* callRemoteMcpServerToolResumable({ ...call, options: {} }).pipe(
        Effect.provide(layer)
      )

      if (!Predicate.isTagged(outcome, 'Complete')) {
        return expect.fail(`Expected Complete, got ${outcome._tag}`)
      }

      expect(outcome.result.isError).toBe(true)
      expect(yield* Ref.get(runs)).toEqual([])
    })
  )
})
