import { Effect, Layer, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  callRemoteMcpServerToolResumable,
  resumeRemoteMcpServerToolCall,
  McpInputRequired,
  type McpElicitationResponses,
  type McpRemoteServerConfig
} from '../../src/client'
import {
  approvalInputKey,
  forwardStaleMessage,
  forwardUnsupportedMessage,
  makeMcpToolServer,
  McpForwardRound,
  McpServerError,
  type McpServerApprovalOptions,
  type McpServerTool
} from '../../src/server'
import {
  CallResult,
  decodeJson,
  InputRequired,
  jsonObject,
  key,
  modernRequest,
  respond,
  type ToolServer
} from './mcp-requests'

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

const parameters = { type: 'object', properties: { id: { type: 'string' } } }

/** The remote server: `delete` asks its own approval, like a confirmation-gated tool. */
const remoteServer = (deleted: Ref.Ref<ReadonlyArray<string>>) =>
  makeMcpToolServer({
    name: 'remote',
    version: '0',
    approvals: { key, principal: 'remote-token' },
    tools: [
      {
        def: ToolDef.make({ name: 'delete', description: 'Delete', parameters }),
        approval: { message: call => Effect.succeed(`Delete ${JSON.stringify(call.params)}?`) },
        execute: (call, approved) =>
          Ref.update(deleted, ids => [...ids, approved.approvalId]).pipe(
            Effect.as(ToolResult.make({ toolCallId: call.id, content: 'deleted' }))
          )
      }
    ]
  })

const remoteConfig: McpRemoteServerConfig = {
  name: 'remote',
  type: 'remote',
  url: 'https://remote.example.com/mcp'
}

type Rounds = Array<string>

/** The proxy (o-o): `proxy_delete` forwards to the remote `delete`, recording each round. */
const proxyServer = (input: {
  readonly remote: ToolServer
  readonly rounds: Rounds
  /** The `roundId` of each resume, in order. */
  readonly roundIds: Array<string>
  readonly approvals: McpServerApprovalOptions | undefined
  readonly askFirst: boolean
}) => {
  const remote = inProcess(input.remote)

  const forwarding: McpServerTool = {
    def: ToolDef.make({ name: 'proxy_delete', description: 'Delete remotely', parameters }),
    forward: true,
    approval: input.askFirst ? { message: () => Effect.succeed('Run proxy_delete?') } : undefined,
    execute: (call, round) => {
      const base = {
        config: remoteConfig,
        mcpToolName: 'delete',
        toolCallId: call.id,
        params: call.params
      }

      const effect = McpForwardRound.$match(round, {
        Initial: ({ clientElicitation, approvalId }) => {
          input.rounds.push(`initial:${clientElicitation}:${approvalId ?? '-'}`)

          return callRemoteMcpServerToolResumable({
            ...base,
            options: clientElicitation ? { elicitation: { form: true } } : {}
          })
        },
        Resume: ({ roundId, inputRequired, responses, approvalId }) => {
          input.rounds.push(`resume:${roundId.length > 0}:${approvalId ?? '-'}`)
          input.roundIds.push(roundId)

          return resumeRemoteMcpServerToolCall({
            ...base,
            inputRequired,
            responses,
            options: { elicitation: { form: true } }
          })
        }
      })

      return effect.pipe(
        Effect.provide(remote),
        Effect.mapError(
          error => new McpServerError({ message: error.message, cause: 'tool_error' })
        )
      )
    }
  }

  return input.approvals === undefined
    ? makeMcpToolServer({ name: 'proxy', version: '0', tools: [forwarding] })
    : makeMcpToolServer({
        name: 'proxy',
        version: '0',
        tools: [forwarding],
        approvals: input.approvals
      })
}

/** A raw round answering `requestState` (answers optional), expecting another prompt. */
const stateRound = (
  proxy: ToolServer,
  requestState: string | undefined,
  inputResponses: McpElicitationResponses | undefined
) =>
  requestState === undefined
    ? Effect.die(new Error('Expected a forwarded requestState'))
    : respond(
        proxy,
        modernRequest({
          method: 'tools/call',
          toolName: 'proxy_delete',
          params: jsonObject(
            inputResponses === undefined
              ? { name: 'proxy_delete', arguments: { id: 'e1' }, requestState }
              : { name: 'proxy_delete', arguments: { id: 'e1' }, requestState, inputResponses }
          )
        })
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)))

const proxyCall = {
  config: { name: 'proxy', type: 'remote', url: 'https://proxy.example.com/mcp' },
  mcpToolName: 'proxy_delete',
  toolCallId: 'call_1',
  params: { id: 'e1' },
  options: { elicitation: { form: true } }
} satisfies Parameters<typeof callRemoteMcpServerToolResumable>[0]

const approve: McpElicitationResponses = {
  [approvalInputKey]: { action: 'accept', content: { decision: 'approve' } }
}

const setup = (
  options: {
    readonly askFirst?: boolean
    readonly approvals?: boolean
    readonly ttlSeconds?: number
  } = {}
) =>
  Effect.gen(function* () {
    const deleted = yield* Ref.make<ReadonlyArray<string>>([])
    const rounds: Rounds = []
    const roundIds: Array<string> = []

    const proxy = proxyServer({
      remote: remoteServer(deleted),
      rounds,
      roundIds,
      approvals:
        options.approvals === false
          ? undefined
          : { key, principal: 'proxy-token', ttlSeconds: options.ttlSeconds ?? 600 },
      askFirst: options.askFirst === true
    })

    return { deleted, rounds, roundIds, proxy, layer: inProcess(proxy) }
  })

describe('forwarding a remote elicitation', () => {
  it.effect('asks the client the remote form, then resumes the remote call once', () =>
    Effect.gen(function* () {
      const { deleted, rounds, layer } = yield* setup()
      const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${first._tag}`)

      expect(first.inputRequired.elicitations.map(form => [form.key, form.message])).toEqual([
        [approvalInputKey, 'Delete {"id":"e1"}?']
      ])
      expect(yield* Ref.get(deleted)).toEqual([])

      const resumed = yield* resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: first.inputRequired,
        responses: approve
      }).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(resumed, 'Complete'))
        return expect.fail(`Expected Complete, got ${resumed._tag}`)

      expect(resumed.result.content).toBe('deleted')
      expect(yield* Ref.get(deleted)).toHaveLength(1)
      expect(rounds).toEqual(['initial:true:-', 'resume:true:-'])
    })
  )

  it.effect('forwards a cancel to the remote server, which runs nothing', () =>
    Effect.gen(function* () {
      const { deleted, rounds, layer } = yield* setup()
      const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${first._tag}`)

      // The client checks answers too, so send the unfit answer as a raw retry of the pause.
      const again = yield* resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: first.inputRequired,
        responses: { [approvalInputKey]: { action: 'cancel' } }
      }).pipe(Effect.provide(layer))

      // A cancel is an answer the remote server receives: it runs nothing.
      if (!Predicate.isTagged(again, 'Complete'))
        return expect.fail(`Expected Complete, got ${again._tag}`)

      expect(again.result.isError).toBe(true)
      expect(yield* Ref.get(deleted)).toEqual([])
      expect(rounds).toEqual(['initial:true:-', 'resume:true:-'])
    })
  )

  it.effect('never forwards to a client that does not declare form elicitation', () =>
    Effect.gen(function* () {
      const { deleted, rounds, layer } = yield* setup()

      const outcome = yield* callRemoteMcpServerToolResumable({ ...proxyCall, options: {} }).pipe(
        Effect.provide(layer)
      )

      if (!Predicate.isTagged(outcome, 'Complete'))
        return expect.fail(`Expected Complete, got ${outcome._tag}`)

      // The proxy opted out on the remote call, so the remote server refused to ask.
      expect(outcome.result.isError).toBe(true)
      expect(rounds).toEqual(['initial:false:-'])
      expect(yield* Ref.get(deleted)).toEqual([])
    })
  )

  it.effect('without approvals, a remote pause is answered as unsupported', () =>
    Effect.gen(function* () {
      const { rounds, layer } = yield* setup({ approvals: false })
      const outcome = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(outcome, 'Complete'))
        return expect.fail(`Expected Complete, got ${outcome._tag}`)

      expect(outcome.result.isError).toBe(true)
      expect(rounds).toEqual(['initial:false:-'])
    })
  )

  it.effect('asks its own approval first, then forwards under that approval', () =>
    Effect.gen(function* () {
      const { deleted, rounds, layer } = yield* setup({ askFirst: true })
      const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${first._tag}`)

      expect(first.inputRequired.elicitations[0]?.message).toBe('Run proxy_delete?')
      expect(rounds).toEqual([])

      const forwarded = yield* resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: first.inputRequired,
        responses: approve
      }).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(forwarded, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${forwarded._tag}`)

      expect(forwarded.inputRequired.elicitations[0]?.message).toBe('Delete {"id":"e1"}?')

      const done = yield* resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: forwarded.inputRequired,
        responses: approve
      }).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(done, 'Complete'))
        return expect.fail(`Expected Complete, got ${done._tag}`)

      expect(done.result.content).toBe('deleted')
      expect(rounds).toHaveLength(2)
      expect(rounds[0]).toMatch(/^initial:true:[0-9a-f-]{36}$/u)
      expect(rounds[1]).toMatch(/^resume:true:[0-9a-f-]{36}$/u)
      expect(yield* Ref.get(deleted)).toHaveLength(1)
    })
  )

  it.effect(
    'answers a request carrying a state that does not verify as stale, sending nothing',
    () =>
      Effect.gen(function* () {
        const deleted = yield* Ref.make<ReadonlyArray<string>>([])
        const rounds: Rounds = []

        const proxy = proxyServer({
          remote: remoteServer(deleted),
          rounds,
          roundIds: [],
          approvals: { key, principal: 'proxy-token' },
          askFirst: false
        })

        const answer = yield* respond(
          proxy,
          modernRequest({
            method: 'tools/call',
            toolName: 'proxy_delete',
            params: jsonObject({
              name: 'proxy_delete',
              arguments: { id: 'e1' },
              requestState: 'forged',
              inputResponses: approve
            })
          })
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)))

        expect(answer.result.isError).toBe(true)
        expect(answer.result.content[0]?.text).toBe(forwardStaleMessage)
        expect(rounds).toEqual([])
        expect(yield* Ref.get(deleted)).toEqual([])
      })
  )

  it.effect('asks again in the same round: a re-asked pause never opens a second resume', () =>
    Effect.gen(function* () {
      const { roundIds, proxy, layer } = yield* setup()
      const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${first._tag}`)

      yield* resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: first.inputRequired,
        responses: approve
      }).pipe(Effect.provide(layer))

      // The answered state again, without answers: asked again, under the same round.
      const again = yield* stateRound(proxy, first.inputRequired.requestState, undefined)

      yield* resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: McpInputRequired.make({
          ...first.inputRequired,
          requestState: again.result.requestState
        }),
        responses: approve
      }).pipe(Effect.provide(layer))

      expect(roundIds).toHaveLength(2)
      expect(roundIds[1]).toBe(roundIds[0])
    })
  )

  // Real time: the server runs each request on its own runtime clock.
  it.live('keeps the first expiry when asking again, then answers stale', () =>
    Effect.gen(function* () {
      const { rounds, proxy, layer } = yield* setup({ ttlSeconds: 2 })
      const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${first._tag}`)

      yield* Effect.sleep('1200 millis')

      const again = yield* stateRound(proxy, first.inputRequired.requestState, undefined)

      // Past the first expiry, while the re-asked state's own signature is still fresh.
      yield* Effect.sleep('1200 millis')

      const late = yield* respond(
        proxy,
        modernRequest({
          method: 'tools/call',
          toolName: 'proxy_delete',
          params: jsonObject({
            name: 'proxy_delete',
            arguments: { id: 'e1' },
            requestState: again.result.requestState,
            inputResponses: approve
          })
        })
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)))

      expect(late.result.content[0]?.text).toBe(forwardStaleMessage)
      expect(rounds).toEqual(['initial:true:-'])
    })
  )

  it.effect('runs only the first round on the header-less JSON path', () =>
    Effect.gen(function* () {
      const deleted = yield* Ref.make<ReadonlyArray<string>>([])
      const rounds: Rounds = []

      const proxy = proxyServer({
        remote: remoteServer(deleted),
        rounds,
        roundIds: [],
        approvals: { key, principal: 'proxy-token' },
        askFirst: false
      })

      const body = yield* proxy.handleJson(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'proxy_delete', arguments: { id: 'e1' } }
        })
      )

      const answer = yield* decodeJson(body).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CallResult))
      )

      expect(answer.result.isError).toBe(true)
      expect(rounds).toEqual(['initial:false:-'])
      expect(forwardUnsupportedMessage).toContain('did not complete')
    })
  )
})
