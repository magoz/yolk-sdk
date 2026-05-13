import '@/lib/dotenv'
import { randomBytes, randomUUID } from 'node:crypto'
import tls from 'node:tls'
import { eq } from 'drizzle-orm'
import { Effect, Redacted } from 'effect'
import * as Schema from 'effect/Schema'
import { TokenBrokerResponse } from '@yolk/oauth'
import { makeOpenAiCodexBrokerRequest, openAiCodexProviderId } from '@yolk/openai'
import { Db } from '@/lib/services/db/live-layer'
import * as dbSchema from '@/lib/services/db/schema'

const codexHost = 'chatgpt.com'
const codexPath = '/backend-api/codex/responses'

class SmokeConfigError extends Schema.TaggedErrorClass<SmokeConfigError>()('SmokeConfigError', {
  message: Schema.String
}) {}

class SmokeHttpError extends Schema.TaggedErrorClass<SmokeHttpError>()('SmokeHttpError', {
  message: Schema.String
}) {}

const requireEnv = (name: string) => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    return Effect.fail(new SmokeConfigError({ message: `Missing ${name}` }))
  }
  return Effect.succeed(value)
}

const configuredOrFirstCodexUserId = () => {
  const configured = process.env.YOLK_CODEX_SMOKE_USER_ID
  if (configured !== undefined && configured.length > 0) return Effect.succeed(configured)

  return Effect.gen(function* () {
    const db = yield* Db
    const [account] = yield* db
      .select({ userId: dbSchema.account.userId })
      .from(dbSchema.account)
      .where(eq(dbSchema.account.providerId, openAiCodexProviderId))
      .limit(1)

    if (account === undefined) {
      return yield* new SmokeConfigError({
        message: 'Missing YOLK_CODEX_SMOKE_USER_ID and no OpenAI Codex account found'
      })
    }

    return account.userId
  }).pipe(Effect.provide(Db.layer))
}

const appUrlFromEnv = () => process.env.YOLK_APP_URL ?? 'http://localhost:4114'

const tokenEndpoint = (appUrl: string) => `${appUrl}/api/internal/cloudflare/codex-token`

const fetchToken = (input: { readonly userId: string; readonly bridgeSecret: Redacted.Redacted }) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(tokenEndpoint(appUrlFromEnv()), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-yolk-cloudflare-secret': Redacted.value(input.bridgeSecret)
        },
        body: JSON.stringify(
          makeOpenAiCodexBrokerRequest({ subjectId: input.userId, minTtlSeconds: 300 })
        )
      })

      if (!response.ok) {
        throw new Error(`Token broker failed: ${response.status} ${await response.text()}`)
      }

      return await response.json()
    },
    catch: error =>
      new SmokeHttpError({ message: error instanceof Error ? error.message : String(error) })
  }).pipe(
    Effect.flatMap(json =>
      Schema.decodeUnknownEffect(TokenBrokerResponse)(json).pipe(
        Effect.mapError(error => new SmokeHttpError({ message: error.message }))
      )
    )
  )

const encodeClientTextFrame = (text: string) => {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  const lengthBytes =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff])
  const masked = Buffer.alloc(payload.length)

  for (let index = 0; index < payload.length; index++) {
    const maskByte = mask[index % 4]
    if (maskByte !== undefined) masked[index] = payload[index] ^ maskByte
  }

  return Buffer.concat([lengthBytes, mask, masked])
}

const decodeServerFrames = (buffer: Buffer) => {
  const frames: Array<string> = []
  let offset = 0

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    if (first === undefined || second === undefined) break

    const opcode = first & 0x0f
    let length = second & 0x7f
    let headerLength = 2

    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    }

    if (length === 127) break
    if (offset + headerLength + length > buffer.length) break

    const payload = buffer.subarray(offset + headerLength, offset + headerLength + length)
    offset += headerLength + length

    if (opcode === 1) frames.push(payload.toString('utf8'))
    if (opcode === 8) frames.push(`[close] ${payload.toString('utf8')}`)
  }

  return { frames, rest: buffer.subarray(offset) }
}

const runCodexWsSmoke = (input: {
  readonly token: typeof TokenBrokerResponse.Type
  readonly sessionId: string
}) =>
  Effect.callback<string, SmokeHttpError>(resume => {
    const socket = tls.connect({ host: codexHost, port: 443, servername: codexHost }, () => {
      const key = randomBytes(16).toString('base64')
      const accountHeader =
        input.token.accountId === undefined ? [] : [`ChatGPT-Account-Id: ${input.token.accountId}`]
      socket.write(
        [
          `GET ${codexPath} HTTP/1.1`,
          `Host: ${codexHost}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${key}`,
          `Authorization: Bearer ${input.token.accessToken}`,
          'OpenAI-Beta: responses_websockets=2026-02-06',
          'User-Agent: opencode/0.0.0 (local smoke)',
          'originator: opencode',
          `session_id: ${input.sessionId}`,
          `x-client-request-id: ${randomUUID()}`,
          'x-codex-installation-id: yolk-local-smoke',
          'x-openai-internal-codex-residency: us',
          ...accountHeader,
          '',
          ''
        ].join('\r\n')
      )
    })
    let raw: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let upgraded = false
    let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const received: Array<string> = []
    const timeout = setTimeout(() => {
      cleanup()
      resume(Effect.succeed(`Timed out. Frames:\n${received.join('\n')}`))
    }, 20_000)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.end()
    }
    const sendPrompt = () => {
      socket.write(
        encodeClientTextFrame(
          JSON.stringify({
            type: 'response.create',
            model: 'gpt-5.4',
            instructions: 'You are a smoke test assistant.',
            input: [{ role: 'user', content: 'Reply with exactly: pong' }],
            store: false,
            stream: true,
            reasoning: { effort: 'low', summary: 'auto' }
          })
        )
      )
    }
    const onData = (chunk: Buffer) => {
      if (!upgraded) {
        raw = Buffer.concat([raw, chunk])
        const splitAt = raw.indexOf('\r\n\r\n')
        if (splitAt === -1) return

        const headers = raw.subarray(0, splitAt + 4).toString('utf8')
        if (!headers.startsWith('HTTP/1.1 101')) {
          cleanup()
          resume(Effect.succeed(headers))
          return
        }

        upgraded = true
        frameBuffer = raw.subarray(splitAt + 4)
        sendPrompt()
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk])
      }

      const decoded = decodeServerFrames(frameBuffer)
      frameBuffer = decoded.rest
      for (const frame of decoded.frames) {
        received.push(frame)
        if (
          frame.includes('response.completed') ||
          frame.includes('response.failed') ||
          frame.startsWith('[close]') ||
          received.length >= 20
        ) {
          cleanup()
          resume(Effect.succeed(received.join('\n')))
          return
        }
      }
    }
    const onError = (error: Error) => {
      cleanup()
      resume(Effect.fail(new SmokeHttpError({ message: error.message })))
    }

    socket.on('data', onData)
    socket.once('error', onError)

    return Effect.sync(cleanup)
  })

const program = Effect.gen(function* () {
  const userId = yield* configuredOrFirstCodexUserId()
  const bridgeSecret = Redacted.make(yield* requireEnv('YOLK_CLOUDFLARE_BRIDGE_SECRET'))
  const token = yield* fetchToken({ userId, bridgeSecret })
  const response = yield* runCodexWsSmoke({ token, sessionId: `local-smoke-${randomUUID()}` })

  console.log(response)
})

Effect.runPromise(program).catch(error => {
  console.error(error)
  process.exitCode = 1
})
