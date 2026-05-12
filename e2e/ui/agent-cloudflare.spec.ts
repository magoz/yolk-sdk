import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentWebSocketServerMessage,
  UserInput,
  UserMessage,
  type AgentWebSocketServerMessage as AgentWebSocketServerMessageType
} from '@yolk/protocol'
import { test, expect } from '../fixtures'

type SocketTurnResult = {
  readonly snapshotRevision: number
  readonly snapshotMessageCount: number
  readonly text: string
}

const cloudflareAgentUrl = process.env.CLOUDFLARE_AGENT_URL ?? ''
const turnTimeoutMs = 30_000

const webSocketUrl = (baseUrl: string, sessionId: string) => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/connect/${encodeURIComponent(sessionId)}`
  return url.toString()
}

const decodeServerMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentWebSocketServerMessage)
)

const encodeUserInput = (input: string, expectedRevision: number) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(
    UserInput.make({
      expectedRevision,
      message: UserMessage.make({ content: input })
    })
  )

class CloudflareAgentE2eError extends Error {
  readonly _tag = 'CloudflareAgentE2eError'
}

const socketError = (message: string, cause?: unknown) =>
  new CloudflareAgentE2eError(message, { cause })

const runSocketTurn = (url: string, input: string) =>
  Effect.callback<SocketTurnResult, CloudflareAgentE2eError>(resume => {
    const socket = new WebSocket(url)
    let snapshotRevision = 0
    let snapshotMessageCount = 0
    let text = ''
    let done = false

    const timeout = setTimeout(() => {
      done = true
      socket.close(1000, 'timeout')
      resume(Effect.fail(socketError('Timed out waiting for agent turn')))
    }, turnTimeoutMs)

    const finish = (effect: Effect.Effect<SocketTurnResult, CloudflareAgentE2eError>) => {
      if (done) {
        return
      }

      done = true
      clearTimeout(timeout)
      socket.close(1000, 'done')
      resume(effect)
    }

    const handleServerMessage = (message: AgentWebSocketServerMessageType) => {
      switch (message._tag) {
        case 'SessionSnapshot':
          snapshotRevision = message.revision
          snapshotMessageCount = message.messages.length
          Effect.runFork(
            encodeUserInput(input, message.revision).pipe(
              Effect.tap(encoded => Effect.sync(() => socket.send(encoded))),
              Effect.catch(error => Effect.sync(() => finish(Effect.fail(socketError('Encode failed', error)))))
            )
          )
          return
        case 'LLMTextDelta':
          text = `${text}${message.text}`
          return
        case 'AgentEnd':
          finish(Effect.succeed({ snapshotRevision, snapshotMessageCount, text }))
          return
        case 'AgentError':
          finish(Effect.fail(socketError(message.message)))
          return
        default:
          return
      }
    }

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        finish(Effect.fail(socketError('Expected text websocket message')))
        return
      }

      Effect.runFork(
        decodeServerMessage(event.data).pipe(
          Effect.tap(message => Effect.sync(() => handleServerMessage(message))),
          Effect.catch(error => Effect.sync(() => finish(Effect.fail(socketError('Decode failed', error)))))
        )
      )
    }

    const onError = () => finish(Effect.fail(socketError('WebSocket failed')))

    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)

    return Effect.sync(() => {
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.close(1000, 'cleanup')
    })
  })

const readSnapshot = (url: string) =>
  Effect.callback<{ readonly revision: number; readonly messageTags: ReadonlyArray<string> }, CloudflareAgentE2eError>(
    resume => {
      const socket = new WebSocket(url)
      let done = false

      const timeout = setTimeout(() => {
        done = true
        socket.close(1000, 'timeout')
        resume(Effect.fail(socketError('Timed out waiting for snapshot')))
      }, turnTimeoutMs)

      const finish = (
        effect: Effect.Effect<
          { readonly revision: number; readonly messageTags: ReadonlyArray<string> },
          CloudflareAgentE2eError
        >
      ) => {
        if (done) {
          return
        }

        done = true
        clearTimeout(timeout)
        socket.close(1000, 'done')
        resume(effect)
      }

      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') {
          finish(Effect.fail(socketError('Expected text websocket message')))
          return
        }

        Effect.runFork(
          decodeServerMessage(event.data).pipe(
            Effect.tap(message =>
              Effect.sync(() => {
                if (message._tag === 'SessionSnapshot') {
                  finish(
                    Effect.succeed({
                      revision: message.revision,
                      messageTags: message.messages.map(agentMessage => agentMessage._tag)
                    })
                  )
                }
              })
            ),
            Effect.catch(error =>
              Effect.sync(() => finish(Effect.fail(socketError('Decode failed', error))))
            )
          )
        )
      }

      const onError = () => finish(Effect.fail(socketError('WebSocket failed')))

      socket.addEventListener('message', onMessage)
      socket.addEventListener('error', onError)

      return Effect.sync(() => {
        clearTimeout(timeout)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('error', onError)
        socket.close(1000, 'cleanup')
      })
    }
  )

test('Cloudflare agent persists transcript across direct WebSocket reconnects', async () => {
  test.setTimeout(90_000)
  test.skip(cloudflareAgentUrl === '', 'CLOUDFLARE_AGENT_URL required for Cloudflare agent E2E')

  const wsUrl = webSocketUrl(cloudflareAgentUrl, `e2e-cloudflare-${randomUUID()}`)
  const first = await Effect.runPromise(runSocketTurn(wsUrl, 'alpha'))

  expect(first).toEqual({
    snapshotRevision: 0,
    snapshotMessageCount: 0,
    text: 'faux-cloudflare: alpha'
  })

  const second = await Effect.runPromise(runSocketTurn(wsUrl, 'beta'))

  expect(second).toEqual({
    snapshotRevision: 3,
    snapshotMessageCount: 2,
    text: 'faux-cloudflare: beta'
  })

  const snapshot = await Effect.runPromise(readSnapshot(wsUrl))

  expect(snapshot).toEqual({
    revision: 6,
    messageTags: ['User', 'Assistant', 'User', 'Assistant']
  })
})
