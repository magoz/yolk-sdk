'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Effect, Exit, Scope, Stream } from 'effect'
import type {
  HitlResponse,
  ToolApprovalRequest,
  ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'
import { ToolApprovalResponse as ToolApprovalResponseClass } from '@yolk-sdk/agent/protocol'
import {
  makeWebRtcVoiceTransport,
  type WebRtcMediaStreamLike,
  type WebRtcVoiceRuntime
} from './browser/index.ts'
import type { VoiceClientCodec } from './client-codec.ts'
import { makeVoiceController, type VoiceControllerApi } from './controller.ts'
import { makeVoiceEventOutbox, type VoiceEventOutboxOptions } from './outbox.ts'
import {
  VoiceSessionError,
  type VoiceEvent,
  type VoiceToolCall,
  type VoiceToolCallOutcome
} from './protocol.ts'
import {
  voiceSeedTextsFromMessages,
  type VoiceSeedText,
  type VoiceSeedTextOptions
} from './projection.ts'

export type YolkVoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

export type UseYolkVoiceOptions = {
  /** Host SDP exchange: POST the offer SDP to an app route, return answer. */
  readonly negotiate: (offerSdp: string) => Effect.Effect<string, VoiceSessionError>
  /** Host server tool endpoint call; never executes tools in the browser. */
  readonly executeToolCall: (
    call: VoiceToolCall,
    approval?: ToolApprovalResponse
  ) => Effect.Effect<VoiceToolCallOutcome, VoiceSessionError>
  /** Provider client codec, e.g. `openAiRealtimeVoiceClientCodec`. */
  readonly codec: VoiceClientCodec
  /** Provider server-event decoder to provider-neutral voice events. */
  readonly decodeMessage: (raw: string) => ReadonlyArray<VoiceEvent>
  /** Provider data channel label, e.g. `oai-events`. */
  readonly dataChannelLabel: string
  /** Conversation seeds replayed into each new provider session. */
  readonly seeds?: () => ReadonlyArray<VoiceSeedText>
  /**
   * Durable session-log outbox: every session event is buffered as a
   * replay-safe `StoredVoiceEvent` and batch-flushed to the host endpoint
   * (see `makeVoiceEventOutbox`). Use a keepalive-capable `flush` so the
   * final batch survives page unload; the host folds batches with
   * `foldStoredVoiceEvents`.
   */
  readonly eventLog?: VoiceEventOutboxOptions
  readonly onEvent?: (event: VoiceEvent) => void
  readonly onError?: (error: VoiceSessionError) => void
  readonly readyTimeoutMs?: number
  /** Test seam; defaults to real browser WebRTC APIs. */
  readonly runtime?: WebRtcVoiceRuntime
}

export type YolkVoiceApi = {
  readonly status: YolkVoiceStatus
  readonly error: VoiceSessionError | null
  readonly isConnecting: boolean
  readonly isLive: boolean
  /** Streaming user transcript draft; cleared on each final transcript. */
  readonly userDraft: string
  /** Pending voice tool approvals awaiting a HITL response. */
  readonly pendingApprovals: ReadonlyArray<ToolApprovalRequest>
  readonly start: () => void
  readonly stop: () => void
  readonly toggle: () => void
  readonly sendText: (text: string) => void
  readonly submitHitlResponse: (response: HitlResponse) => void
  readonly approveTool: (requestId: string, toolCallId: string) => void
  readonly denyTool: (requestId: string, toolCallId: string, reason?: string) => void
  /** Attach the audio element that plays the assistant's voice. */
  readonly attachAudioElement: (element: HTMLAudioElement | null) => void
}

type VoiceHookState = {
  readonly status: YolkVoiceStatus
  readonly error: VoiceSessionError | null
  readonly userDraft: string
  readonly pendingApprovals: ReadonlyArray<ToolApprovalRequest>
}

type VoiceHookAction =
  | { readonly _tag: 'Connecting' }
  | { readonly _tag: 'Live' }
  | { readonly _tag: 'Stopped' }
  | { readonly _tag: 'Errored'; readonly error: VoiceSessionError }
  | { readonly _tag: 'Event'; readonly event: VoiceEvent }
  | { readonly _tag: 'ApprovalSubmitted'; readonly requestId: string }

const initialVoiceHookState: VoiceHookState = {
  status: 'idle',
  error: null,
  userDraft: '',
  pendingApprovals: []
}

const applyEvent = (state: VoiceHookState, event: VoiceEvent): VoiceHookState => {
  switch (event._tag) {
    case 'UserTranscriptDelta':
      return { ...state, userDraft: `${state.userDraft}${event.delta}` }
    case 'UserTranscriptFinal':
      return { ...state, userDraft: '' }
    case 'AwaitingInput': {
      const approvals = event.requests.filter(request => request._tag === 'ToolApprovalRequest')

      return approvals.length === 0
        ? state
        : { ...state, pendingApprovals: [...state.pendingApprovals, ...approvals] }
    }
    case 'ToolCallCompleted':
    case 'ToolCallFailed':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          request => request.toolCallId !== event.callId
        )
      }
    case 'Error':
      return {
        ...state,
        status: 'error',
        error: new VoiceSessionError({ code: event.code, message: event.message })
      }
    case 'SessionClosed':
      return state.status === 'error' ? state : { ...state, status: 'idle', userDraft: '' }
    default:
      return state
  }
}

const reduceVoiceHookState = (state: VoiceHookState, action: VoiceHookAction): VoiceHookState => {
  switch (action._tag) {
    case 'Connecting':
      return { ...initialVoiceHookState, status: 'connecting' }
    case 'Live':
      return { ...state, status: 'live', error: null }
    case 'Stopped':
      return { ...state, status: 'idle', userDraft: '' }
    case 'Errored':
      return { ...state, status: 'error', error: action.error }
    case 'Event':
      return applyEvent(state, action.event)
    case 'ApprovalSubmitted':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          request => request.requestId !== action.requestId
        )
      }
  }
}

const isDomMediaStream = (
  stream: WebRtcMediaStreamLike
): stream is WebRtcMediaStreamLike & MediaStream =>
  typeof MediaStream !== 'undefined' && stream instanceof MediaStream

/**
 * Headless browser voice hook over the Yolk WebRTC transport and voice
 * controller. Owns connection lifecycle, event-derived UI state, and HITL
 * approval submission. Rendering, chat projection, and product policy stay
 * host-owned; subscribe with `onEvent` to project transcripts into chat
 * state.
 */
export const useYolkVoice = (options: UseYolkVoiceOptions): YolkVoiceApi => {
  const [state, dispatch] = useReducer(reduceVoiceHookState, initialVoiceHookState)
  const scopeRef = useRef<Scope.Closeable | null>(null)
  const controllerRef = useRef<VoiceControllerApi | null>(null)
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const attemptIdRef = useRef(0)
  const optionsRef = useRef(options)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const isConnecting = state.status === 'connecting'
  const isLive = state.status === 'live'

  const closeSession = useCallback(() => {
    const scope = scopeRef.current
    scopeRef.current = null
    controllerRef.current = null

    if (audioElementRef.current !== null) {
      audioElementRef.current.srcObject = null
    }

    if (scope !== null) {
      Effect.runFork(Scope.close(scope, Exit.void))
    }
  }, [])

  const stop = useCallback(() => {
    attemptIdRef.current += 1
    closeSession()
    dispatch({ _tag: 'Stopped' })
  }, [closeSession])

  const start = useCallback(() => {
    if (scopeRef.current !== null) {
      return
    }

    const attemptId = attemptIdRef.current + 1
    attemptIdRef.current = attemptId
    dispatch({ _tag: 'Connecting' })

    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()

      if (attemptIdRef.current !== attemptId) {
        yield* Scope.close(scope, Exit.void)
        return
      }

      scopeRef.current = scope

      const opts = optionsRef.current
      const { session, outbox } = yield* Scope.provide(
        Effect.gen(function* () {
          const transport = yield* makeWebRtcVoiceTransport({
            negotiate: opts.negotiate,
            decodeMessage: opts.decodeMessage,
            dataChannelLabel: opts.dataChannelLabel,
            readyTimeoutMs: opts.readyTimeoutMs,
            runtime: opts.runtime,
            onRemoteAudioStream: stream => {
              const element = audioElementRef.current

              if (element !== null && isDomMediaStream(stream)) {
                element.srcObject = stream
              }
            }
          })
          const controller = yield* makeVoiceController({
            transport,
            codec: opts.codec,
            executeToolCall: opts.executeToolCall
          })
          const eventOutbox =
            opts.eventLog === undefined ? null : yield* makeVoiceEventOutbox(opts.eventLog)

          return { session: controller, outbox: eventOutbox }
        }),
        scope
      )

      controllerRef.current = session

      const seeds = optionsRef.current.seeds?.() ?? []
      yield* Effect.forEach(
        seeds,
        seed =>
          seed.role === 'user'
            ? session.seedUserText(seed.text)
            : session.seedAssistantText(seed.text),
        { discard: true }
      )

      if (attemptIdRef.current === attemptId) {
        dispatch({ _tag: 'Live' })
      }

      yield* Stream.runForEach(session.events, event =>
        Effect.gen(function* () {
          if (attemptIdRef.current !== attemptId) {
            return
          }

          if (outbox !== null) {
            yield* outbox.offer(event)
          }

          optionsRef.current.onEvent?.(event)
          dispatch({ _tag: 'Event', event })

          if (event._tag === 'Error') {
            optionsRef.current.onError?.(
              new VoiceSessionError({ code: event.code, message: event.message })
            )
          }
        })
      )
    })

    Effect.runFork(
      program.pipe(
        Effect.matchEffect({
          onFailure: error =>
            Effect.sync(() => {
              closeSession()

              if (attemptIdRef.current === attemptId) {
                dispatch({ _tag: 'Errored', error })
                optionsRef.current.onError?.(error)
              }
            }),
          onSuccess: () =>
            Effect.sync(() => {
              if (attemptIdRef.current === attemptId) {
                closeSession()
                dispatch({ _tag: 'Stopped' })
              }
            })
        })
      )
    )
  }, [closeSession])

  const toggle = useCallback(() => {
    if (isConnecting || isLive) {
      stop()
      return
    }

    start()
  }, [isConnecting, isLive, start, stop])

  const sendText = useCallback((text: string) => {
    const controller = controllerRef.current

    if (controller === null || text.trim().length === 0) {
      return
    }

    Effect.runFork(
      controller
        .sendText(text)
        .pipe(Effect.catch(error => Effect.sync(() => optionsRef.current.onError?.(error))))
    )
  }, [])

  const submitHitlResponse = useCallback((response: HitlResponse) => {
    const controller = controllerRef.current

    if (controller === null) {
      return
    }

    if (response._tag === 'ToolApprovalResponse') {
      dispatch({ _tag: 'ApprovalSubmitted', requestId: response.requestId })
    }

    Effect.runFork(controller.submitHitlResponse(response))
  }, [])

  const approveTool = useCallback(
    (requestId: string, toolCallId: string) => {
      submitHitlResponse(
        ToolApprovalResponseClass.make({
          requestId,
          toolCallId,
          decision: 'approved',
          source: 'user'
        })
      )
    },
    [submitHitlResponse]
  )

  const denyTool = useCallback(
    (requestId: string, toolCallId: string, reason?: string) => {
      submitHitlResponse(
        ToolApprovalResponseClass.make({
          requestId,
          toolCallId,
          decision: 'denied',
          source: 'user',
          ...(reason === undefined ? {} : { reason })
        })
      )
    },
    [submitHitlResponse]
  )

  const attachAudioElement = useCallback((element: HTMLAudioElement | null) => {
    audioElementRef.current = element
  }, [])

  useEffect(
    () => () => {
      attemptIdRef.current += 1
      closeSession()
    },
    [closeSession]
  )

  return {
    status: state.status,
    error: state.error,
    isConnecting,
    isLive,
    userDraft: state.userDraft,
    pendingApprovals: state.pendingApprovals,
    start,
    stop,
    toggle,
    sendText,
    submitHitlResponse,
    approveTool,
    denyTool,
    attachAudioElement
  }
}

export { voiceSeedTextsFromMessages }
export type { VoiceSeedText, VoiceSeedTextOptions }
