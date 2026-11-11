/**
 * User approval of a tool call through MCP form elicitation over multi round-trip requests (MRTR,
 * protocol `2026-07-28`). The server never blocks on a human and keeps no state: the first
 * `tools/call` of an approval tool answers an `InputRequiredResult` holding one form elicitation
 * (`approvalInputKey`, no fields: the client offers accept, decline and cancel) and a signed
 * `requestState`; the client re-sends the same call with the user's decision and that state, and
 * only an `accept` bound to the same principal, tool and arguments runs the tool.
 *
 * `requestState` is HMAC-signed by the SDK's `createRequestStateCodec`, expires (`ttlSeconds`),
 * and is bound to the host's authenticated principal and the `tools/call` method; its payload
 * names the tool, the canonical digest of the arguments (`mcpArgumentsDigest`) and a fresh
 * `approvalId`. A state that fails verification, belongs to another call, or arrives without a
 * decision is never an approval: the server asks again with a new state. The server does not
 * enforce once-only execution: an accepted state replays until it expires, so the host keys
 * once-only execution on `approvalId` (MRTR: signing, binding and expiry "do not by themselves
 * guarantee single-use"; the server must enforce it).
 *
 * A request that does not declare form elicitation gets a tool error result, not the SDK's
 * `-32021` missing-capability error: the calling agent reads why nothing ran, and nothing is
 * signed. The SDK's own capability gate still refuses an elicitation it would send to such a
 * client.
 */
import { Data, Effect, Option, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext
} from '@modelcontextprotocol/server'
import type { ToolCall } from '@yolk-sdk/agent/protocol'
import { mcpArgumentsDigest } from '@yolk-sdk/mcp/client'
import { McpServerError } from './errors.ts'

/** Host configuration for approval tools. Without it no approval tool is offered. */
export type McpServerApprovalOptions = {
  /**
   * The HMAC key that signs `requestState`: at least 32 bytes (a string is UTF-8 encoded), the same
   * on every instance that may receive the retried call.
   */
  readonly key: Uint8Array | string
  /**
   * The authenticated principal of this request (for example the access token's id): a state
   * minted for one principal is never an approval for another.
   */
  readonly principal: string
  /** How long the user has to decide, in seconds (a positive integer). Default `600`. */
  readonly ttlSeconds?: number
}

/** A call the user approved. `approvalId` is unique per prompt: key once-only execution on it. */
export type McpServerToolApproved = {
  readonly approvalId: string
}

/** How an approval tool asks: `message` is shown to the user verbatim, as plain text. */
export type McpServerToolApprovalPolicy<R = never> = {
  readonly message: (call: ToolCall) => Effect.Effect<string, McpServerError, R>
}

/** The `inputRequests` key of the approval elicitation. */
export const approvalInputKey = 'approval'

const ApprovalState = Schema.Struct({
  tool: Schema.String,
  argumentsDigest: Schema.String,
  approvalId: Schema.String
})

type ApprovalState = typeof ApprovalState.Type

const decodeApprovalState = Schema.decodeUnknownOption(ApprovalState)

const ElicitDecision = Schema.Struct({ action: Schema.Literals(['accept', 'decline', 'cancel']) })

const decodeDecision = Schema.decodeUnknownOption(ElicitDecision)

/** The capabilities a 2026-07-28 request declares in its `_meta` envelope. */
const EnvelopeCapabilities = Schema.Struct({
  [CLIENT_CAPABILITIES_META_KEY]: Schema.Struct({
    elicitation: Schema.optional(
      Schema.Struct({
        form: Schema.optional(Schema.Unknown),
        url: Schema.optional(Schema.Unknown)
      })
    )
  })
})

const decodeEnvelopeCapabilities = Schema.decodeUnknownOption(EnvelopeCapabilities)

/**
 * Whether the request declares form elicitation: `elicitation.form`, or an empty `elicitation`
 * (the spec's backwards-compatible form-only declaration). `url` alone is not form.
 */
export const declaresFormElicitation = (envelope: unknown) =>
  Option.match(decodeEnvelopeCapabilities(envelope), {
    onNone: () => false,
    onSome: capabilities => {
      const elicitation = capabilities[CLIENT_CAPABILITIES_META_KEY].elicitation

      if (elicitation === undefined) return false

      return elicitation.form !== undefined || elicitation.url === undefined
    }
  })

/** The approval machinery of one server instance, or why approval tools cannot run. */
export type McpServerApprovals = Data.TaggedEnum<{
  Unconfigured: Record<never, never>
  Misconfigured: { readonly message: string }
  Configured: { readonly codec: RequestStateCodec<ApprovalState> }
}>

export const McpServerApprovals = Data.taggedEnum<McpServerApprovals>()

/**
 * The approvals of one server instance, bound to the server's `name`, the host's principal and the
 * method, so a state minted for one is never an approval on another sharing the key. A key under
 * 32 bytes, an empty principal or a `ttlSeconds` that is not a positive integer is `Misconfigured`.
 */
export const makeMcpServerApprovals = (
  serverName: string,
  options: McpServerApprovalOptions | undefined
): McpServerApprovals => {
  if (options === undefined) return McpServerApprovals.Unconfigured()

  const principal = options.principal
  const ttlSeconds = options.ttlSeconds ?? 600

  if (principal.length === 0) {
    return McpServerApprovals.Misconfigured({ message: 'approvals.principal is empty' })
  }

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    return McpServerApprovals.Misconfigured({
      message: 'approvals.ttlSeconds must be a positive integer'
    })
  }

  const codec = Result.try({
    try: () =>
      createRequestStateCodec<ApprovalState>({
        key: options.key,
        ttlSeconds,
        bind: ctx => `${serverName}\0${principal}\0${ctx.mcpReq.method}`
      }),
    catch: error => (error instanceof Error ? error.message : String(error))
  })

  return Result.match(codec, {
    onFailure: message => McpServerApprovals.Misconfigured({ message }),
    onSuccess: configured => McpServerApprovals.Configured({ codec: configured })
  })
}

/** The outcome of one approval round: run the tool, answer with a result, or ask the user. */
export type McpApprovalRound = Data.TaggedEnum<{
  Run: { readonly approved: McpServerToolApproved }
  Answer: { readonly message: string }
  Ask: { readonly result: InputRequiredResult }
}>

export const McpApprovalRound = Data.taggedEnum<McpApprovalRound>()

const answer = (message: string) => Effect.succeed(McpApprovalRound.Answer({ message }))

const decodeRawState = Schema.decodeUnknownOption(Schema.String)

const verifiedState = (
  codec: RequestStateCodec<ApprovalState>,
  ctx: ServerContext
): Effect.Effect<Option.Option<ApprovalState>> =>
  Option.match(decodeRawState(ctx.mcpReq.requestState<unknown>()), {
    onNone: () => Effect.succeed(Option.none<ApprovalState>()),
    onSome: raw =>
      Effect.tryPromise(() => codec.verify(raw, ctx)).pipe(
        Effect.map(decodeApprovalState),
        Effect.orElseSucceed(() => Option.none<ApprovalState>())
      )
  })

const decisionOf = (ctx: ServerContext) =>
  Option.map(
    decodeDecision(ctx.mcpReq.inputResponses?.[approvalInputKey]),
    decision => decision.action
  )

/**
 * One round of an approval tool's call. Never runs the tool without an `accept` answering a
 * verified state for the same tool and arguments; every other path answers or asks again.
 */
export const approvalRound = <R>(input: {
  readonly approvals: McpServerApprovals
  readonly policy: McpServerToolApprovalPolicy<R>
  readonly call: ToolCall
  readonly ctx: ServerContext
}): Effect.Effect<McpApprovalRound, McpServerError, R> =>
  McpServerApprovals.$match(input.approvals, {
    Unconfigured: () =>
      answer("This tool needs the user's approval, which this server does not offer."),
    // The reason names a configuration field or the SDK's key-length check, never the key.
    Misconfigured: ({ message }) =>
      answer(`This tool needs the user's approval, which is misconfigured here (${message}).`),
    Configured: ({ codec }) => configuredRound({ ...input, codec })
  })

const configuredRound = <R>(input: {
  readonly codec: RequestStateCodec<ApprovalState>
  readonly policy: McpServerToolApprovalPolicy<R>
  readonly call: ToolCall
  readonly ctx: ServerContext
}): Effect.Effect<McpApprovalRound, McpServerError, R> =>
  Effect.gen(function* () {
    const { codec, call, ctx } = input

    if (!declaresFormElicitation(ctx.mcpReq.envelope)) {
      return yield* answer(
        'This tool runs only after the user approves it, and this MCP client does not support ' +
          'form elicitation (protocol 2026-07-28). Nothing ran.'
      )
    }

    const argumentsDigest = yield* mcpArgumentsDigest(call.params).pipe(
      Effect.mapError(
        error =>
          new McpServerError({
            message: `Invalid tools/call arguments: not JSON: ${error.message}`,
            cause: 'validation'
          })
      )
    )

    const state = Option.filter(
      yield* verifiedState(codec, ctx),
      current => current.tool === call.name && current.argumentsDigest === argumentsDigest
    )

    const decision = Option.flatMap(state, () => decisionOf(ctx))

    if (Option.isSome(state) && Option.isSome(decision)) {
      switch (decision.value) {
        case 'accept':
          return McpApprovalRound.Run({ approved: { approvalId: state.value.approvalId } })
        case 'decline':
          return yield* answer('The user declined this call. Nothing ran.')
        case 'cancel':
          return yield* answer('The user dismissed the approval request. Nothing ran.')
      }
    }

    const message = yield* input.policy.message(call)

    const requestState = yield* Effect.tryPromise({
      try: () =>
        codec.mint({ tool: call.name, argumentsDigest, approvalId: crypto.randomUUID() }, ctx),
      catch: error =>
        new McpServerError({
          message: `Could not sign the approval request: ${error instanceof Error ? error.message : String(error)}`,
          cause: 'protocol'
        })
    })

    return McpApprovalRound.Ask({
      result: inputRequired({
        inputRequests: {
          [approvalInputKey]: inputRequired.elicit({
            mode: 'form',
            message,
            requestedSchema: { type: 'object', properties: {} }
          })
        },
        requestState
      })
    })
  })
