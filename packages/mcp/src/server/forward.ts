/**
 * Forwarding a remote MCP server's form elicitation to this server's client (MRTR, protocol
 * `2026-07-28`). A forwarding tool proxies a remote tool: its first round calls the remote server;
 * when that server pauses the call for input (`McpInputRequired`), this server asks its own client
 * the same forms under a signed `requestState` holding the remote pause, and the client's answers
 * resume the remote call. The server keeps no state between rounds.
 *
 * The forward state is signed by the approvals key (`forwardCodec`: bound to the server `name`,
 * the host's principal, the method and the forward purpose) but not encrypted: the client can read
 * the remote pause (its forms and the remote `requestState`), so a remote `requestState` must not
 * be secret from this server's client. It names the tool, the arguments digest, a `roundId`, the
 * remote pause and its expiry (`ttlSeconds` after the remote pause was first forwarded). Only a
 * round whose verified, unexpired state matches the call and answers every forwarded form resumes
 * the remote call; a round that misses an answer is asked the same forms again under the same
 * `roundId` and expiry, so asking again neither opens a second resume nor keeps the pause alive.
 * A new remote pause's `roundId` is derived from where it came from (the approval or the resumed
 * round) and the pause, so a host that answers a retried round with the outcome it stored asks the
 * same pause in the same round (with a new expiry). The server does not enforce once-only
 * resumption: a replayed answered round arrives again with the same `roundId`, so the host keys
 * once-only execution on it (MRTR's single-use is the server's duty).
 */
import { Clock, Data, Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  inputRequired,
  isSpecType,
  type InputRequiredResult,
  type ServerContext
} from '@modelcontextprotocol/server'
import { type ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  mcpArgumentsDigest,
  McpElicitationResponse,
  McpInputRequired,
  toMcpInputResponses,
  type McpElicitationResponses,
  type McpToolCallOutcome
} from '@yolk-sdk/mcp/client'
import {
  declaresFormElicitation,
  type McpServerApprovals,
  type McpServerCallOutcome
} from './approval.ts'
import { McpServerError } from './errors.ts'

/**
 * One round of a forwarding tool's call, as the host's `execute` receives it.
 * - `Initial`: call the remote tool. `clientElicitation` says whether this server can forward a
 *   pause to its client (a `2026-07-28` request declaring form elicitation, with approvals
 *   configured): opt the remote call into elicitation only then, so a remote server that needs
 *   input answers that it cannot run instead of pausing a call nobody can answer.
 * - `Resume`: resume the remote pause with the client's answers. `roundId` names one forwarded
 *   remote pause: key once-only resumption on it. A retried round answered with the outcome the
 *   host stored forwards that pause again under the same `roundId`.
 *
 * `approvalId` is set when the tool also asks this server's approval first (an approval forwarding
 * tool): it names the approval the call runs under, on every later round too.
 */
export type McpForwardRound = Data.TaggedEnum<{
  Initial: {
    readonly clientElicitation: boolean
    readonly approvalId: string | undefined
  }
  Resume: {
    readonly roundId: string
    readonly inputRequired: McpInputRequired
    readonly responses: McpElicitationResponses
    readonly approvalId: string | undefined
  }
}>

export const McpForwardRound = Data.taggedEnum<McpForwardRound>()

/** Most UTF-8 bytes of a forward state's JSON: a larger remote pause is not forwarded. */
export const mcpForwardMaxStateBytes = 65_536

/** The answer to a call whose remote server needs input this client cannot give. */
export const forwardUnsupportedMessage =
  'The remote tool needs input, and this MCP client does not support form elicitation (protocol 2026-07-28). It did not complete.'

/** The answer to a remote pause that holds no form (a retry request), never shown to anyone. */
export const forwardEmptyPauseMessage =
  'The remote tool asked to be called again later without asking anything. It did not complete; call it again.'

/** The answer to a remote pause too large to forward (`mcpForwardMaxStateBytes`). */
export const forwardOversizedMessage =
  'The remote tool asked for input too large to forward. It did not complete.'

/** The answer to a remote pause whose forms this server cannot ask again. */
export const forwardMalformedMessage =
  'The remote tool asked for input in a form that cannot be forwarded. It did not complete.'

/** The answer to a forwarded answer whose state no longer verifies (expired or changed). */
export const forwardStaleMessage =
  'This call answers a forwarded prompt that expired or no longer matches. Nothing more ran; call it again.'

const ForwardState = Schema.Struct({
  kind: Schema.Literal('forward'),
  tool: Schema.String,
  argumentsDigest: Schema.String,
  roundId: Schema.String,
  /** When the remote pause stops being answerable here (epoch ms), kept when asked again. */
  expiresAtMs: Schema.Number,
  approvalId: Schema.optionalKey(Schema.String),
  pause: McpInputRequired
})

type ForwardState = typeof ForwardState.Type

const ForwardStateJson = Schema.toCodecJson(ForwardState)

const decodeForwardState = Schema.decodeUnknownOption(ForwardStateJson)

const encodeForwardState = Schema.encodeUnknownEffect(ForwardStateJson)

const decodeResponse = Schema.decodeUnknownOption(McpElicitationResponse)

const decodeRawState = Schema.decodeUnknownOption(Schema.String)

const errorResult = (call: ToolCall, message: string): McpServerCallOutcome =>
  ToolResult.make({ toolCallId: call.id, content: message, isError: true })

const encoder = new TextEncoder()

/** Whether the request carries a `requestState`, so it answers a prompt of an earlier round. */
export const answersRound = (ctx: ServerContext) =>
  Option.isSome(decodeRawState(ctx.mcpReq.requestState<unknown>()))

/** The verified forward state of this round, when it belongs to this call. */
const verifiedForwardState = (
  approvals: McpServerApprovals,
  call: ToolCall,
  argumentsDigest: string,
  ctx: ServerContext
): Effect.Effect<Option.Option<ForwardState>> => {
  if (!Predicate.isTagged(approvals, 'Configured')) return Effect.succeed(Option.none())

  const { forwardCodec } = approvals

  return Option.match(decodeRawState(ctx.mcpReq.requestState<unknown>()), {
    onNone: () => Effect.succeed(Option.none<ForwardState>()),
    onSome: raw =>
      Effect.tryPromise(() => forwardCodec.verify(raw, ctx)).pipe(
        Effect.flatMap(payload =>
          Effect.map(Clock.currentTimeMillis, now =>
            Option.filter(
              decodeForwardState(payload),
              state =>
                state.tool === call.name &&
                state.argumentsDigest === argumentsDigest &&
                now < state.expiresAtMs
            )
          )
        ),
        Effect.orElseSucceed(() => Option.none<ForwardState>())
      )
  })
}

/** The client's answers to every forwarded form, or none when any is missing or does not fit. */
const answersOf = (state: ForwardState, ctx: ServerContext) =>
  Effect.gen(function* () {
    const entries = state.pause.elicitations.map(
      form => [form.key, decodeResponse(ctx.mcpReq.inputResponses?.[form.key])] as const
    )

    if (entries.some(([, response]) => Option.isNone(response)))
      return Option.none<McpElicitationResponses>()

    const responses: McpElicitationResponses = Object.fromEntries(
      entries.flatMap(([key, response]) => (Option.isSome(response) ? [[key, response.value]] : []))
    )

    // The forms are the remote server's: check the answers before resuming, as the client would.
    return yield* toMcpInputResponses({
      server: state.tool,
      inputRequired: state.pause,
      responses
    }).pipe(
      Effect.as(Option.some(responses)),
      Effect.orElseSucceed(() => Option.none<McpElicitationResponses>())
    )
  })

/**
 * What a remote pause came from, by the host's once-only key of the round that answered it: the
 * approval (`Initial` of an approval forwarding tool), the forwarded round it resumed (`Resume`), or
 * a first round without approval (`call`), which has no key.
 */
type ForwardOrigin =
  | { readonly kind: 'approval'; readonly approvalId: string }
  | { readonly kind: 'round'; readonly roundId: string }
  | { readonly kind: 'call' }

/**
 * The round a forwarded prompt belongs to: a new remote pause opens one (expiry `ttlSeconds` from
 * now); asking a pause's forms again keeps its round.
 */
type ForwardRound =
  | { readonly kind: 'new'; readonly origin: ForwardOrigin }
  | { readonly kind: 'again'; readonly roundId: string; readonly expiresAtMs: number }

/** What names a remote pause: its forms, remote `requestState` and binding (not `tool`). */
const PauseIdentity = Schema.Struct({
  elicitations: McpInputRequired.fields.elicitations,
  requestState: McpInputRequired.fields.requestState,
  mcpToolName: McpInputRequired.fields.mcpToolName,
  argumentsDigest: McpInputRequired.fields.argumentsDigest
})

const encodePauseIdentity = Schema.encodeUnknownEffect(Schema.toCodecJson(PauseIdentity))

/**
 * The `roundId` of a new remote pause: the digest of its origin and the pause (its forms, remote
 * `requestState` and binding; not the listed tool definition). A host that answers a retried round
 * (an accepted approval, a `Resume`) with the outcome it stored forwards the same pause from the
 * same origin, so it is asked in the same round, and the host's once-only key on `roundId` still
 * resumes it once. A fresh `roundId` there would open a second resume of one remote pause. A first
 * round without approval has no once-only key, so its round is random.
 */
const newRoundId = (origin: ForwardOrigin, pause: McpInputRequired) => {
  if (origin.kind === 'call') return Effect.succeed(crypto.randomUUID())

  return encodePauseIdentity(pause).pipe(
    Effect.flatMap(identity =>
      mcpArgumentsDigest({
        origin:
          origin.kind === 'approval' ? `approval:${origin.approvalId}` : `round:${origin.roundId}`,
        pause: identity
      })
    ),
    Effect.mapError(
      error =>
        new McpServerError({
          message: `Could not encode the forwarded prompt: ${error.message}`,
          cause: 'encoding'
        })
    )
  )
}

/** Asks the client the remote pause's forms under a signed forward state of its round. */
const ask = (input: {
  readonly approvals: McpServerApprovals
  readonly call: ToolCall
  readonly argumentsDigest: string
  readonly pause: McpInputRequired
  readonly approvalId: string | undefined
  readonly round: ForwardRound
  readonly ctx: ServerContext
}): Effect.Effect<McpServerCallOutcome, McpServerError> =>
  Effect.gen(function* () {
    const { approvals, call, pause } = input

    if (!Predicate.isTagged(approvals, 'Configured'))
      return errorResult(call, forwardUnsupportedMessage)

    const now = yield* Clock.currentTimeMillis

    const round =
      input.round.kind === 'again'
        ? { roundId: input.round.roundId, expiresAtMs: input.round.expiresAtMs }
        : {
            roundId: yield* newRoundId(input.round.origin, pause),
            expiresAtMs: now + approvals.ttlSeconds * 1000
          }

    const base = {
      kind: 'forward' as const,
      tool: call.name,
      argumentsDigest: input.argumentsDigest,
      ...round,
      pause
    }

    const state: ForwardState =
      input.approvalId === undefined ? base : { ...base, approvalId: input.approvalId }

    const encoded = yield* encodeForwardState(state).pipe(
      Effect.mapError(
        error =>
          new McpServerError({
            message: `Could not encode the forwarded prompt: ${error.message}`,
            cause: 'encoding'
          })
      )
    )

    if (encoder.encode(JSON.stringify(encoded)).length > mcpForwardMaxStateBytes)
      return errorResult(call, forwardOversizedMessage)

    const requestState = yield* Effect.tryPromise({
      try: () => approvals.forwardCodec.mint(encoded, input.ctx),
      catch: error =>
        new McpServerError({
          message: `Could not sign the forwarded prompt: ${error instanceof Error ? error.message : String(error)}`,
          cause: 'protocol'
        })
    })

    // The client decoded the remote forms with Yolk's schema; the SDK's guard types them again.
    const forms = pause.elicitations.flatMap(form => {
      const params = { mode: 'form', message: form.message, requestedSchema: form.requestedSchema }

      return isSpecType.ElicitRequestFormParams(params) ? [[form.key, params] as const] : []
    })

    if (forms.length !== pause.elicitations.length)
      return errorResult(call, forwardMalformedMessage)

    const result: InputRequiredResult = inputRequired({
      inputRequests: Object.fromEntries(
        forms.map(([key, params]) => [key, inputRequired.elicit(params)])
      ),
      requestState
    })

    return result
  })

/** What a remote round came to, as this server answers it. */
const outcomeOf = (input: {
  readonly approvals: McpServerApprovals
  readonly call: ToolCall
  readonly argumentsDigest: string
  readonly outcome: McpToolCallOutcome
  readonly approvalId: string | undefined
  readonly origin: ForwardOrigin
  readonly clientElicitation: boolean
  readonly ctx: ServerContext | undefined
}): Effect.Effect<McpServerCallOutcome, McpServerError> => {
  const { call, outcome } = input

  if (Predicate.isTagged(outcome, 'Complete')) return Effect.succeed(outcome.result)

  if (outcome.inputRequired.elicitations.length === 0)
    return Effect.succeed(errorResult(call, forwardEmptyPauseMessage))

  if (!input.clientElicitation || input.ctx === undefined)
    return Effect.succeed(errorResult(call, forwardUnsupportedMessage))

  return ask({
    approvals: input.approvals,
    call,
    argumentsDigest: input.argumentsDigest,
    pause: outcome.inputRequired,
    approvalId: input.approvalId,
    round: { kind: 'new', origin: input.origin },
    ctx: input.ctx
  })
}

/** Whether this request can carry a forwarded prompt to its client. */
const clientElicits = (input: {
  readonly approvals: McpServerApprovals
  readonly ctx: ServerContext | undefined
  readonly modern: boolean
}) =>
  input.modern &&
  input.ctx !== undefined &&
  Predicate.isTagged(input.approvals, 'Configured') &&
  declaresFormElicitation(input.ctx.mcpReq.envelope)

const argumentsDigestOf = (call: ToolCall) =>
  mcpArgumentsDigest(call.params).pipe(
    Effect.mapError(
      error =>
        new McpServerError({
          message: `Invalid tools/call arguments: not JSON: ${error.message}`,
          cause: 'validation'
        })
    )
  )

/**
 * The first round of a forwarding tool's call: run the remote call and answer its result, or
 * forward its pause. `ctx` is absent off the SDK path (the header-less JSON path), which forwards
 * nothing.
 */
export const forwardInitialRound = <R>(input: {
  readonly approvals: McpServerApprovals
  readonly execute: (
    call: ToolCall,
    round: McpForwardRound
  ) => Effect.Effect<McpToolCallOutcome, McpServerError, R>
  readonly call: ToolCall
  readonly approvalId: string | undefined
  readonly ctx: ServerContext | undefined
  readonly modern: boolean
}): Effect.Effect<McpServerCallOutcome, McpServerError, R> =>
  Effect.gen(function* () {
    const { call, ctx } = input
    const clientElicitation = clientElicits(input)

    const argumentsDigest = yield* argumentsDigestOf(call)

    const outcome = yield* input.execute(
      call,
      McpForwardRound.Initial({ clientElicitation, approvalId: input.approvalId })
    )

    return yield* outcomeOf({
      approvals: input.approvals,
      call,
      argumentsDigest,
      outcome,
      approvalId: input.approvalId,
      origin:
        input.approvalId === undefined
          ? { kind: 'call' }
          : { kind: 'approval', approvalId: input.approvalId },
      clientElicitation,
      ctx
    })
  })

/**
 * A round answering a forwarded prompt, or none when the request carries no verified forward state
 * for this call (the caller then runs its first round, or answers that the state is stale). Only
 * answers to every forwarded form resume the remote call; otherwise the same forms are asked again
 * in the same round (`roundId` and expiry kept).
 */
export const forwardAnswerRound = <R>(input: {
  readonly approvals: McpServerApprovals
  readonly execute: (
    call: ToolCall,
    round: McpForwardRound
  ) => Effect.Effect<McpToolCallOutcome, McpServerError, R>
  readonly call: ToolCall
  readonly ctx: ServerContext
}): Effect.Effect<Option.Option<McpServerCallOutcome>, McpServerError, R> =>
  Effect.gen(function* () {
    const { approvals, call, ctx } = input
    const argumentsDigest = yield* argumentsDigestOf(call)
    const state = yield* verifiedForwardState(approvals, call, argumentsDigest, ctx)

    if (Option.isNone(state)) return Option.none()

    const forward = state.value
    const responses = yield* answersOf(forward, ctx)

    if (Option.isNone(responses))
      return Option.some(
        yield* ask({
          approvals,
          call,
          argumentsDigest,
          pause: forward.pause,
          approvalId: forward.approvalId,
          round: { kind: 'again', roundId: forward.roundId, expiresAtMs: forward.expiresAtMs },
          ctx
        })
      )

    const outcome = yield* input.execute(
      call,
      McpForwardRound.Resume({
        roundId: forward.roundId,
        inputRequired: forward.pause,
        responses: responses.value,
        approvalId: forward.approvalId
      })
    )

    return Option.some(
      yield* outcomeOf({
        approvals,
        call,
        argumentsDigest,
        outcome,
        approvalId: forward.approvalId,
        origin: { kind: 'round', roundId: forward.roundId },
        clientElicitation: clientElicits({ approvals, ctx, modern: true }),
        ctx
      })
    )
  })
