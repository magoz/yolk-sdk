import { Effect, Layer, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  callRemoteMcpServerToolResumable,
  resumeRemoteMcpServerToolCall,
  McpFormElicitation,
  McpInputRequired,
  McpToolCallComplete,
  McpToolCallInputRequired,
  type McpClientOptions,
  type McpElicitationResponses,
  type McpRemoteServerConfig,
  type McpToolCallOutcome
} from '../../src/client'
import {
  approvalInputKey,
  forwardEmptyPauseMessage,
  forwardStaleMessage,
  forwardUnsupportedMessage,
  makeMcpToolServer,
  McpForwardRound,
  McpServerError,
  type McpServerApprovalOptions,
  type McpServerForwardingTool
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

/**
 * The host's once-only keys (`approval:<approvalId>`, `forward:<roundId>`), kept the idempotent
 * way: a duplicate key answers the outcome stored under it, as a tool-call ledger replays a
 * completed call. A first round without approval has no key and always runs.
 */
const replaying = (tool: McpServerForwardingTool): McpServerForwardingTool => {
  const stored = new Map<string, McpToolCallOutcome>()

  return {
    ...tool,
    execute: (call, round) => {
      const key = McpForwardRound.$match(round, {
        Initial: ({ approvalId }) =>
          approvalId === undefined ? undefined : `approval:${approvalId}`,
        Resume: ({ roundId }) => `forward:${roundId}`
      })

      if (key === undefined) return tool.execute(call, round)

      const replayed = stored.get(key)

      if (replayed !== undefined) return Effect.succeed(replayed)

      return tool
        .execute(call, round)
        .pipe(Effect.tap(outcome => Effect.sync(() => stored.set(key, outcome))))
    }
  }
}

/** The proxy (o-o): `proxy_delete` forwards to the remote `delete`, recording each round. */
const proxyServer = (input: {
  readonly remote: ToolServer
  readonly rounds: Rounds
  /** The `roundId` of each resume, in order. */
  readonly roundIds: Array<string>
  readonly approvals: McpServerApprovalOptions | undefined
  readonly askFirst: boolean
  /** Whether the host answers a duplicate once-only key with its stored outcome (`replaying`). */
  readonly replays?: boolean
}) => {
  const remote = inProcess(input.remote)

  const proxied: McpServerForwardingTool = {
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

  const forwarding = input.replays === true ? replaying(proxied) : proxied

  return input.approvals === undefined
    ? makeMcpToolServer({ name: 'proxy', version: '0', tools: [forwarding] })
    : makeMcpToolServer({
        name: 'proxy',
        version: '0',
        tools: [forwarding],
        approvals: input.approvals
      })
}

const StateEnvelope = Schema.fromJsonString(
  Schema.Struct({ p: Schema.Struct({ roundId: Schema.String, expiresAtMs: Schema.Number }) })
)

/** The forward state a signed `requestState` holds (`mcp1.<base64url body>.<mac>`). */
const statePayload = (requestState: string | undefined) => {
  const state = requestState ?? ''
  const body = state.slice(state.indexOf('.') + 1, state.lastIndexOf('.'))

  return Schema.decodeUnknownEffect(StateEnvelope)(Buffer.from(body, 'base64url').toString()).pipe(
    Effect.map(envelope => envelope.p),
    Effect.orDie
  )
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
    readonly replays?: boolean
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
      askFirst: options.askFirst === true,
      replays: options.replays === true
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

      // The state is signed, not encrypted: the re-asked one keeps the round and its first expiry.
      const asked = yield* statePayload(first.inputRequired.requestState)
      const reasked = yield* statePayload(again.result.requestState)

      expect(reasked.roundId).toBe(asked.roundId)
      expect(reasked.expiresAtMs).toBe(asked.expiresAtMs)
    })
  )

  // Issue #297: an accepted approval retried after a lost response, against a host that answers
  // its duplicate `approvalId` with the stored remote pause, forwards that pause in the same round.
  it.effect('forwards a replayed remote pause in the same round, so it resumes once', () =>
    Effect.gen(function* () {
      const { deleted, roundIds, layer } = yield* setup({ askFirst: true, replays: true })
      const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

      if (!Predicate.isTagged(first, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${first._tag}`)

      const acceptApproval = resumeRemoteMcpServerToolCall({
        ...proxyCall,
        inputRequired: first.inputRequired,
        responses: approve
      }).pipe(Effect.provide(layer))

      const forwarded = yield* acceptApproval
      const retried = yield* acceptApproval

      if (!Predicate.isTagged(forwarded, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${forwarded._tag}`)

      if (!Predicate.isTagged(retried, 'InputRequired'))
        return expect.fail(`Expected InputRequired, got ${retried._tag}`)

      const asked = yield* statePayload(forwarded.inputRequired.requestState)
      const reasked = yield* statePayload(retried.inputRequired.requestState)

      // Both prompts of the one remote pause are answered (a second tab, the retry's owner).
      for (const prompt of [forwarded, retried])
        yield* resumeRemoteMcpServerToolCall({
          ...proxyCall,
          inputRequired: prompt.inputRequired,
          responses: approve
        }).pipe(Effect.provide(layer))

      expect(yield* Ref.get(deleted)).toHaveLength(1)
      expect(roundIds).toEqual([asked.roundId])
      expect(reasked.roundId).toBe(asked.roundId)
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

  describe('a scripted remote', () => {
    const okForm = McpInputRequired.make({
      elicitations: [
        McpFormElicitation.make({
          key: 'ok',
          message: 'Sure?',
          requestedSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok']
          }
        })
      ],
      requestState: 'remote-1',
      mcpToolName: 'delete',
      argumentsDigest: 'sha256:0'
    })

    const retryLater = McpInputRequired.make({
      elicitations: [],
      requestState: 'later',
      mcpToolName: 'delete',
      argumentsDigest: 'sha256:0'
    })

    /** A forwarding tool whose remote answers `initial`, then `resumed` on every resume. */
    const scripted = (initial: McpInputRequired, resumed: McpInputRequired) =>
      makeMcpToolServer({
        name: 'proxy',
        version: '0',
        approvals: { key, principal: 'proxy-token' },
        tools: [
          {
            def: ToolDef.make({ name: 'proxy_delete', description: 'Delete remotely', parameters }),
            forward: true,
            execute: (_, round) =>
              Effect.succeed(
                McpToolCallInputRequired.make({
                  inputRequired: McpForwardRound.$is('Initial')(round) ? initial : resumed
                })
              )
          }
        ]
      })

    it.effect('answers a remote retry request as such, whatever the client declares', () =>
      Effect.gen(function* () {
        const layer = inProcess(scripted(retryLater, retryLater))

        for (const options of [{}, proxyCall.options] satisfies Array<McpClientOptions>) {
          const outcome = yield* callRemoteMcpServerToolResumable({ ...proxyCall, options }).pipe(
            Effect.provide(layer)
          )

          if (!Predicate.isTagged(outcome, 'Complete'))
            return expect.fail(`Expected Complete, got ${outcome._tag}`)

          expect(outcome.result.content).toBe(forwardEmptyPauseMessage)
        }
      })
    )

    it.effect('never forwards a new remote prompt to a client that stopped declaring forms', () =>
      Effect.gen(function* () {
        const proxy = scripted(okForm, okForm)

        const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(
          Effect.provide(inProcess(proxy))
        )

        if (!Predicate.isTagged(first, 'InputRequired'))
          return expect.fail(`Expected InputRequired, got ${first._tag}`)

        const answer = yield* respond(
          proxy,
          modernRequest({
            method: 'tools/call',
            toolName: 'proxy_delete',
            capabilities: {},
            params: jsonObject({
              name: 'proxy_delete',
              arguments: { id: 'e1' },
              requestState: first.inputRequired.requestState,
              inputResponses: { ok: { action: 'accept', content: { ok: true } } }
            })
          })
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallResult)))

        expect(answer.result.content[0]?.text).toBe(forwardUnsupportedMessage)
      })
    )

    // Issue #297: a retried `Resume` the host answers with the stored next remote pause.
    it.effect('forwards a replayed next pause in the same round, so it resumes once', () =>
      Effect.gen(function* () {
        const nextForm = McpInputRequired.make({ ...okForm, requestState: 'remote-2' })
        const resumed: Array<string | undefined> = []

        const remote: McpServerForwardingTool = {
          def: ToolDef.make({ name: 'proxy_delete', description: 'Delete remotely', parameters }),
          forward: true,
          execute: (call, round) =>
            McpForwardRound.$match(round, {
              Initial: () =>
                Effect.succeed<McpToolCallOutcome>(
                  McpToolCallInputRequired.make({ inputRequired: okForm })
                ),
              Resume: ({ inputRequired }) =>
                Effect.sync((): McpToolCallOutcome => {
                  resumed.push(inputRequired.requestState)

                  return inputRequired.requestState === okForm.requestState
                    ? McpToolCallInputRequired.make({ inputRequired: nextForm })
                    : McpToolCallComplete.make({
                        result: ToolResult.make({ toolCallId: call.id, content: 'deleted' })
                      })
                })
            })
        }

        const layer = inProcess(
          makeMcpToolServer({
            name: 'proxy',
            version: '0',
            approvals: { key, principal: 'proxy-token' },
            tools: [replaying(remote)]
          })
        )

        const ok: McpElicitationResponses = { ok: { action: 'accept', content: { ok: true } } }
        const first = yield* callRemoteMcpServerToolResumable(proxyCall).pipe(Effect.provide(layer))

        if (!Predicate.isTagged(first, 'InputRequired'))
          return expect.fail(`Expected InputRequired, got ${first._tag}`)

        const answerFirst = resumeRemoteMcpServerToolCall({
          ...proxyCall,
          inputRequired: first.inputRequired,
          responses: ok
        }).pipe(Effect.provide(layer))

        const next = yield* answerFirst
        const retried = yield* answerFirst

        if (!Predicate.isTagged(next, 'InputRequired'))
          return expect.fail(`Expected InputRequired, got ${next._tag}`)

        if (!Predicate.isTagged(retried, 'InputRequired'))
          return expect.fail(`Expected InputRequired, got ${retried._tag}`)

        const asked = yield* statePayload(next.inputRequired.requestState)
        const reasked = yield* statePayload(retried.inputRequired.requestState)

        for (const prompt of [next, retried])
          yield* resumeRemoteMcpServerToolCall({
            ...proxyCall,
            inputRequired: prompt.inputRequired,
            responses: ok
          }).pipe(Effect.provide(layer))

        expect(resumed).toEqual(['remote-1', 'remote-2'])
        expect(reasked.roundId).toBe(asked.roundId)
      })
    )
  })
})
