/**
 * Asking the user before a tool call runs, through MCP form elicitation over multi round-trip
 * requests (MRTR, protocol `2026-07-28`). The server never blocks on a human and keeps no state:
 * the first `tools/call` of an asking tool answers an `InputRequiredResult` holding one form
 * elicitation (`approvalInputKey`) and a signed `requestState`; the client re-sends the same call
 * with the user's answer and that state. An approval tool asks one required approve/deny choice
 * (`approvalForm`), never an empty form, which a client may accept without showing it; a deny
 * runs nothing, like a declined form. An elicited tool asks with a form (`form.ts`) whose answer
 * is decoded as untrusted input. Only an `accept` bound to the same principal, tool, arguments and
 * prompt, with an answer that fits the form, runs the call.
 *
 * `requestState` is HMAC-signed by the SDK's `createRequestStateCodec`, expires (`ttlSeconds`),
 * and is bound to the host's authenticated principal and the `tools/call` method; its payload
 * names the tool, the canonical digest of the arguments (`mcpArgumentsDigest`), the digest of the
 * prompt shown (message and form) and a fresh `elicitationId` (an approval tool's `approvalId`).
 * The prompt is rebuilt on the answering round: an accept of a prompt that changed meanwhile is
 * refused (`changedPromptMessage`), and a prompt over `mcpServerMaxPromptBytes` is refused, never
 * cut. A state that fails verification, belongs to another call, or arrives without a decision
 * or with an answer that does not fit is never an approval: the server asks again with a new
 * state. The server does not enforce once-only execution: an accepted state replays until it
 * expires, so the host keys once-only execution on `elicitationId` (MRTR: signing, binding and
 * expiry "do not by themselves guarantee single-use"; the server must enforce it).
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
  type ElicitRequestFormParams,
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext
} from '@modelcontextprotocol/server'
import { type ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import { mcpArgumentsDigest } from '@yolk-sdk/mcp/client'
import { McpServerError } from './errors.ts'
import { mcpFormChoice, mcpServerForm, type McpServerForm } from './form.ts'

/**
 * Host configuration for asking tools (approval and elicited tools). Without it none is offered.
 */
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

/** What an elicited tool asks for one call: `message` as plain text, and the form to fill. */
export type McpServerElicitation<A> = {
  readonly message: string
  readonly form: McpServerForm<A>
}

/**
 * A call the user answered: `answer` is decoded with the form's schema; `elicitationId` is unique
 * per prompt, so key once-only execution on it.
 */
export type McpServerToolAnswered<A> = {
  readonly elicitationId: string
  readonly answer: A
}

/**
 * The prompt an asking tool shows for one call, its answer type erased: `run` decodes an accepted
 * answer and returns the call's execution, or none when the answer does not fit the form.
 */
export type McpServerPrompt<R = never> = {
  readonly message: string
  readonly requestedSchema: ElicitRequestFormParams['requestedSchema']
  readonly run: (
    content: unknown,
    elicitationId: string
  ) => Option.Option<Effect.Effect<ToolResult, McpServerError, R>>
}

/** Most UTF-8 bytes of a prompt's message plus form (JSON): a larger prompt is refused, never cut. */
export const mcpServerMaxPromptBytes = 65_536

/** The `inputRequests` key of the approval elicitation. */
export const approvalInputKey = 'approval'

const ApprovalState = Schema.Struct({
  tool: Schema.String,
  argumentsDigest: Schema.String,
  formDigest: Schema.String,
  elicitationId: Schema.String
})

type ApprovalState = typeof ApprovalState.Type

const decodeApprovalState = Schema.decodeUnknownOption(ApprovalState)

const ElicitDecision = Schema.Struct({
  action: Schema.Literals(['accept', 'decline', 'cancel']),
  content: Schema.optional(Schema.Unknown)
})

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

/** The outcome of one asking round: run the call, answer with a result, or ask the user. */
export type McpApprovalRound<R> = Data.TaggedEnum<{
  Run: { readonly execution: Effect.Effect<ToolResult, McpServerError, R> }
  Answer: { readonly message: string }
  Ask: { readonly result: InputRequiredResult }
}>

interface McpApprovalRoundDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: McpApprovalRound<this['A']>
}

export const McpApprovalRound = Data.taggedEnum<McpApprovalRoundDefinition>()

const answer = (message: string): Effect.Effect<McpApprovalRound<never>> =>
  Effect.succeed(McpApprovalRound.Answer({ message }))

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

/**
 * Whether a call answers an approval prompt: it carries a `requestState` or an answer under
 * `approvalInputKey`. A direct tool never asks, so such a call answers a prompt from when the tool
 * was an approval tool (the host's policy changed in between) and must not run: neither a declined
 * answer nor a replayed accept may become a plain call.
 */
export const answersApproval = (ctx: ServerContext) =>
  Option.isSome(decodeRawState(ctx.mcpReq.requestState<unknown>())) ||
  ctx.mcpReq.inputResponses?.[approvalInputKey] !== undefined

/** The answer to a call that answers a prompt its tool no longer shows. */
export const staleApprovalMessage =
  'This call answers an approval prompt this tool no longer shows. Nothing ran; call it again.'

const decisionOf = (ctx: ServerContext) =>
  decodeDecision(ctx.mcpReq.inputResponses?.[approvalInputKey])

/** The answer to an accepted prompt whose message or form changed since the user saw it. */
export const changedPromptMessage =
  'This prompt changed since it was shown. Nothing ran; call it again.'

/** The answer to a prompt too large to show (`mcpServerMaxPromptBytes`). */
export const oversizedPromptMessage = 'This prompt is too large to show. Nothing ran.'

const encoder = new TextEncoder()

const promptBytes = (prompt: McpServerPrompt<unknown>) =>
  encoder.encode(JSON.stringify({ message: prompt.message, form: prompt.requestedSchema })).length

/** What a declined approval answers (a `deny` choice, or a declined form). */
export const declinedApprovalMessage = 'The user declined this call. Nothing ran.'

/**
 * The approval form (shared by every approval prompt: read it, never change it): one required
 * choice. Never an empty form, which a client may accept without showing it (OpenCode does), so the
 * user always makes the choice; a `deny` is answered like a declined form and runs nothing.
 */
export const approvalForm = mcpServerForm({
  decision: mcpFormChoice({
    title: 'Decision',
    options: [
      { value: 'approve', title: 'Approve: run this call' },
      { value: 'deny', title: 'Deny: do not run it' }
    ]
  })
})

/** An approval tool's prompt: its policy's message and the approve/deny choice (`approvalForm`). */
export const approvalPrompt = <R>(input: {
  readonly policy: McpServerToolApprovalPolicy<R>
  readonly execute: (
    call: ToolCall,
    approved: McpServerToolApproved
  ) => Effect.Effect<ToolResult, McpServerError, R>
  readonly call: ToolCall
}): Effect.Effect<McpServerPrompt<R>, McpServerError, R> =>
  elicitedPrompt({
    elicit: call =>
      Effect.map(input.policy.message(call), message => ({ message, form: approvalForm })),
    execute: (call, answered) =>
      answered.answer.decision === 'approve'
        ? input.execute(call, { approvalId: answered.elicitationId })
        : Effect.succeed(
            ToolResult.make({
              toolCallId: call.id,
              content: declinedApprovalMessage,
              isError: true
            })
          ),
    call: input.call
  })

/** An elicited tool's prompt for one call: its elicitation, with `run` decoding the answer. */
export const elicitedPrompt = <A, R>(input: {
  readonly elicit: (call: ToolCall) => Effect.Effect<McpServerElicitation<A>, McpServerError, R>
  readonly execute: (
    call: ToolCall,
    answered: McpServerToolAnswered<A>
  ) => Effect.Effect<ToolResult, McpServerError, R>
  readonly call: ToolCall
}): Effect.Effect<McpServerPrompt<R>, McpServerError, R> =>
  Effect.flatMap(input.elicit(input.call), elicitation =>
    elicitation.form.problems.length > 0
      ? Effect.fail(
          new McpServerError({
            message: `This form cannot be shown (${elicitation.form.problems.join('; ')}). Nothing ran.`,
            cause: 'validation'
          })
        )
      : Effect.succeed({
          message: elicitation.message,
          requestedSchema: elicitation.form.requestedSchema,
          run: (content: unknown, elicitationId: string) =>
            Option.map(elicitation.form.decode(content), answer =>
              input.execute(input.call, { elicitationId, answer })
            )
        })
  )

/**
 * One round of an asking tool's call (an approval or elicited tool). Never runs the call without an
 * `accept` answering a verified state for the same tool, arguments and prompt, with an answer that
 * fits the form; every other path answers or asks again.
 */
export const approvalRound = <R>(input: {
  readonly approvals: McpServerApprovals
  readonly prompt: (call: ToolCall) => Effect.Effect<McpServerPrompt<R>, McpServerError, R>
  readonly call: ToolCall
  readonly ctx: ServerContext
}): Effect.Effect<McpApprovalRound<R>, McpServerError, R> =>
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
  readonly prompt: (call: ToolCall) => Effect.Effect<McpServerPrompt<R>, McpServerError, R>
  readonly call: ToolCall
  readonly ctx: ServerContext
}): Effect.Effect<McpApprovalRound<R>, McpServerError, R> =>
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

    // Built on every round: an accept is checked against the prompt as it is now.
    const prompt = yield* input.prompt(call)

    if (promptBytes(prompt) > mcpServerMaxPromptBytes) return yield* answer(oversizedPromptMessage)

    const formDigest = yield* mcpArgumentsDigest({
      message: prompt.message,
      form: prompt.requestedSchema
    }).pipe(
      Effect.mapError(
        error =>
          new McpServerError({
            message: `Invalid prompt: not JSON: ${error.message}`,
            cause: 'protocol'
          })
      )
    )

    const state = Option.filter(
      yield* verifiedState(codec, ctx),
      current => current.tool === call.name && current.argumentsDigest === argumentsDigest
    )

    const decision = Option.flatMap(state, () => decisionOf(ctx))

    if (Option.isSome(state) && Option.isSome(decision)) {
      switch (decision.value.action) {
        case 'accept': {
          if (state.value.formDigest !== formDigest) return yield* answer(changedPromptMessage)

          const execution = prompt.run(decision.value.content ?? {}, state.value.elicitationId)

          // An answer that does not fit the form is no answer: ask again.
          if (Option.isSome(execution)) {
            return McpApprovalRound.Run({ execution: execution.value })
          }

          break
        }

        case 'decline':
          return yield* answer(declinedApprovalMessage)
        case 'cancel':
          return yield* answer('The user dismissed the approval request. Nothing ran.')
      }
    }

    const requestState = yield* Effect.tryPromise({
      try: () =>
        codec.mint(
          { tool: call.name, argumentsDigest, formDigest, elicitationId: crypto.randomUUID() },
          ctx
        ),
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
            message: prompt.message,
            requestedSchema: prompt.requestedSchema
          })
        },
        requestState
      })
    })
  })
