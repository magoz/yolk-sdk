import { Cause, Deferred, Effect, Fiber, Option, Queue, Ref, Stream, type Scope } from 'effect'
import * as Schema from 'effect/Schema'
import type {
  HitlResponse,
  ToolApprovalRequest,
  ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'
import type { VoiceClientCodec } from './client-codec.ts'
import {
  VoiceAwaitingInput,
  VoiceToolCallCompleted,
  VoiceToolCallExecuting,
  VoiceToolCallFailed,
  type VoiceEvent,
  type VoiceSessionError,
  type VoiceToolCall,
  type VoiceToolCallOutcome,
  type VoiceToolCallsRequested
} from './protocol.ts'
import type { VoiceTransportApi } from './transport.ts'

/**
 * Client-side voice controller options. The controller never executes tools:
 * `executeToolCall` forwards each provider tool call to the host's
 * authenticated server endpoint and returns the server outcome. Approval
 * resume re-calls the same endpoint with the HITL `approval` response.
 */
export type VoiceControllerOptions = {
  readonly transport: VoiceTransportApi
  readonly codec: VoiceClientCodec
  readonly executeToolCall: (
    call: VoiceToolCall,
    approval?: ToolApprovalResponse
  ) => Effect.Effect<VoiceToolCallOutcome, VoiceSessionError>
}

export type VoiceControllerApi = {
  /** Transport events with tool-call/HITL orchestration events interleaved. */
  readonly events: Stream.Stream<VoiceEvent, VoiceSessionError>
  /** Send a user text message and request a response turn. */
  readonly sendText: (text: string) => Effect.Effect<void, VoiceSessionError>
  /** Seed conversation context without requesting a response turn. */
  readonly seedUserText: (text: string) => Effect.Effect<void, VoiceSessionError>
  readonly seedAssistantText: (text: string) => Effect.Effect<void, VoiceSessionError>
  /**
   * Resolve a pending approval. Question responses are accepted but ignored:
   * voice `question` is deferred from MVP. Unknown or already-settled
   * requests are no-ops so duplicate submissions stay safe.
   */
  readonly submitHitlResponse: (response: HitlResponse) => Effect.Effect<void>
}

type PendingApproval = {
  readonly request: ToolApprovalRequest
  readonly deferred: Deferred.Deferred<ToolApprovalResponse>
}

const encodeErrorOutput = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)

const errorOutputJson = (message: string) =>
  encodeErrorOutput({ error: message }).pipe(Effect.orElseSucceed(() => '{"error":"Tool failed"}'))

const sendAll = (
  transport: VoiceTransportApi,
  payloads: ReadonlyArray<string>
): Effect.Effect<void, VoiceSessionError> =>
  Effect.forEach(payloads, payload => transport.send(payload), { discard: true })

/**
 * Provider-neutral client voice controller. Wraps a connected transport,
 * forwards provider tool calls to the host server endpoint, submits tool
 * outputs back to the provider, requests one response turn per tool batch,
 * and de-dupes provider tool-call re-emissions by call id.
 *
 * Approval-gated calls pause: the controller emits `AwaitingInput` and waits
 * for `submitHitlResponse`. Approvals resume execution through the server;
 * denials submit a model-visible denial output. If the session ends while
 * waiting, the approval stays pending host-side and the stream completes;
 * durable resume happens on reconnect through the host session log.
 *
 * The controller pumps transport events on a scoped background fiber so the
 * session end is observed even while a tool call awaits approval. Closing
 * the scope stops the pump and releases parked approvals.
 */
export const makeVoiceController = (
  options: VoiceControllerOptions
): Effect.Effect<VoiceControllerApi, never, Scope.Scope> =>
  Effect.gen(function* () {
    const out = yield* Queue.unbounded<VoiceEvent, VoiceSessionError | Cause.Done>()
    const handledCallIds = yield* Ref.make<ReadonlySet<string>>(new Set())
    const pendingApprovals = yield* Ref.make<ReadonlyMap<string, PendingApproval>>(new Map())
    const batchFibers = yield* Ref.make<ReadonlyArray<Fiber.Fiber<void>>>([])
    const sessionEnded = yield* Deferred.make<void>()

    const emit = (event: VoiceEvent) => Queue.offer(out, event).pipe(Effect.asVoid)

    const markHandled = (call: VoiceToolCall) =>
      Ref.modify(handledCallIds, handled => {
        if (handled.has(call.callId)) {
          return [false, handled] as const
        }

        return [true, new Set([...handled, call.callId])] as const
      })

    const send = (payloads: Effect.Effect<ReadonlyArray<string>, VoiceSessionError>) =>
      payloads.pipe(Effect.flatMap(encoded => sendAll(options.transport, encoded)))

    const submitOutput = (callId: string, output: string) =>
      send(options.codec.encodeToolOutput(callId, output))

    const emitCompleted = (call: VoiceToolCall, output: string) =>
      submitOutput(call.callId, output).pipe(
        Effect.andThen(emit(VoiceToolCallCompleted.make({ callId: call.callId, output })))
      )

    const emitFailed = (call: VoiceToolCall, message: string, output: string) =>
      submitOutput(call.callId, output).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(emit(VoiceToolCallFailed.make({ callId: call.callId, message })))
      )

    const registerPending = (request: ToolApprovalRequest) =>
      Deferred.make<ToolApprovalResponse>().pipe(
        Effect.tap(deferred =>
          Ref.update(
            pendingApprovals,
            pending => new Map([...pending, [request.requestId, { request, deferred }]])
          )
        )
      )

    const removePending = (requestId: string) =>
      Ref.update(pendingApprovals, pending => {
        const next = new Map(pending)
        next.delete(requestId)

        return next
      })

    const settleOutcome = (
      call: VoiceToolCall,
      outcome: VoiceToolCallOutcome
    ): Effect.Effect<void, VoiceSessionError> => {
      switch (outcome._tag) {
        case 'Executed':
          return emitCompleted(call, outcome.output)
        case 'Denied':
          return emitFailed(
            call,
            outcome.reason === undefined
              ? 'Tool was denied.'
              : `Tool was denied: ${outcome.reason}`,
            outcome.output
          )
        case 'ApprovalRequired': {
          const message = `Tool ${call.name} still requires approval and was not executed.`

          return errorOutputJson(message).pipe(
            Effect.flatMap(output => emitFailed(call, message, output))
          )
        }
      }
    }

    const awaitApproval = (
      call: VoiceToolCall,
      request: ToolApprovalRequest,
      deferred: Deferred.Deferred<ToolApprovalResponse>
    ): Effect.Effect<void, VoiceSessionError> =>
      Effect.raceFirst(
        Deferred.await(deferred).pipe(Effect.map(Option.some)),
        Deferred.await(sessionEnded).pipe(Effect.as(Option.none<ToolApprovalResponse>()))
      ).pipe(
        Effect.flatMap(response => {
          if (Option.isNone(response)) {
            // Session ended while awaiting input. The approval stays pending
            // host-side; resume happens on reconnect through the session log.
            return Effect.void
          }

          return removePending(request.requestId).pipe(
            Effect.andThen(options.executeToolCall(call, response.value)),
            Effect.flatMap(outcome => settleOutcome(call, outcome))
          )
        })
      )

    const runToolCall = (call: VoiceToolCall): Effect.Effect<void, VoiceSessionError> =>
      emit(VoiceToolCallExecuting.make({ callId: call.callId })).pipe(
        Effect.andThen(options.executeToolCall(call)),
        Effect.flatMap(outcome => {
          if (outcome._tag !== 'ApprovalRequired') {
            return settleOutcome(call, outcome)
          }

          return registerPending(outcome.request).pipe(
            Effect.tap(() => emit(VoiceAwaitingInput.make({ requests: [outcome.request] }))),
            Effect.flatMap(deferred => awaitApproval(call, outcome.request, deferred))
          )
        }),
        Effect.catchTag('VoiceSessionError', error =>
          errorOutputJson(error.message).pipe(
            Effect.flatMap(output => emitFailed(call, error.message, output))
          )
        )
      )

    const handleBatch = (event: VoiceToolCallsRequested): Effect.Effect<void> =>
      Effect.gen(function* () {
        const marks = yield* Effect.forEach(event.calls, call => markHandled(call))
        const calls = event.calls.filter((_, index) => marks[index] === true)

        if (calls.length === 0) {
          return
        }

        yield* emit(event)
        yield* Effect.forEach(calls, call => runToolCall(call), { discard: true })
        yield* send(options.codec.encodeResponseTurn()).pipe(Effect.catch(() => Effect.void))
      }).pipe(
        Effect.catch(error =>
          Queue.failCause(out, Cause.fail(error)).pipe(Effect.asVoid)
        )
      )

    const dispatch = (event: VoiceEvent): Effect.Effect<void, never, Scope.Scope> => {
      if (event._tag !== 'ToolCallsRequested') {
        return emit(event)
      }

      return Effect.forkScoped(handleBatch(event)).pipe(
        Effect.flatMap(fiber => Ref.update(batchFibers, fibers => [...fibers, fiber])),
        Effect.asVoid
      )
    }

    const finishPump = (failure: Option.Option<Cause.Cause<VoiceSessionError>>) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(sessionEnded, undefined)
        const fibers = yield* Ref.get(batchFibers)
        yield* Fiber.awaitAll(fibers)

        if (Option.isSome(failure)) {
          yield* Queue.failCause(out, failure.value)
          return
        }

        yield* Queue.end(out)
      })

    yield* Effect.forkScoped(
      Stream.runForEach(options.transport.events, dispatch).pipe(
        Effect.matchCauseEffect({
          onFailure: cause => finishPump(Option.some(cause)),
          onSuccess: () => finishPump(Option.none())
        })
      )
    )

    const sendText = (text: string) =>
      send(options.codec.encodeUserText(text)).pipe(
        Effect.andThen(send(options.codec.encodeResponseTurn()))
      )

    const submitHitlResponse = (response: HitlResponse): Effect.Effect<void> => {
      if (response._tag !== 'ToolApprovalResponse') {
        return Effect.void
      }

      return Ref.get(pendingApprovals).pipe(
        Effect.flatMap(pending => {
          const match =
            pending.get(response.requestId) ??
            [...pending.values()].find(entry => entry.request.toolCallId === response.toolCallId)

          if (match === undefined) {
            return Effect.void
          }

          return Deferred.succeed(match.deferred, response).pipe(Effect.asVoid)
        })
      )
    }

    return {
      events: Stream.fromQueue(out),
      sendText,
      seedUserText: text => send(options.codec.encodeUserText(text)),
      seedAssistantText: text => send(options.codec.encodeAssistantText(text)),
      submitHitlResponse
    }
  })
