/**
 * Node boundary: serve an emulator fetch handler on loopback.
 *
 * This is the only module in the package that imports `node:` builtins.
 * Servers bind to `127.0.0.1` only. Streamed response bodies are written
 * chunk by chunk (honoring backpressure) so progressive delivery survives the
 * socket, and an erroring body stream destroys the connection mid-response,
 * the way a dropped upstream does.
 *
 * @experimental
 */
import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Data, Effect, Predicate, type Scope } from 'effect'

/** A fetch handler, such as the one returned by an emulator factory. */
export type FetchHandler = (request: Request) => Promise<Response>

export type ServeFetchHandlerOptions = {
  /** TCP port; `0` (default) picks a free port. */
  readonly port?: number
  /** Only `127.0.0.1` is accepted (the default); any other host is refused. */
  readonly host?: string
}

/** The only host emulator servers bind to. */
export const emulatorServerHost = '127.0.0.1'

/** Serving failed: a refused host, an invalid port, or a listen error. */
export class EmulatorServeError extends Data.TaggedError('EmulatorServeError')<{
  readonly reason: 'host-not-allowed' | 'invalid-port' | 'listen-failed'
  readonly cause?: unknown
}> {
  override get message(): string {
    switch (this.reason) {
      case 'host-not-allowed':
        return `Emulator servers bind to ${emulatorServerHost} only`
      case 'invalid-port':
        return 'Emulator server port must be an integer from 0 to 65535'
      case 'listen-failed':
        return 'Emulator server could not listen'
    }
  }
}

/** A running loopback server (Promise variant). `close` is idempotent. */
export type RunningFetchHandlerServer = {
  /** Base URL, for example `http://127.0.0.1:43123`. */
  readonly url: string
  readonly close: () => Promise<void>
}

/** A running loopback server (Effect variant). `close` is idempotent. */
export type ServedFetchHandler = {
  readonly url: string
  readonly close: Effect.Effect<void>
}

const validateOptions = (options: ServeFetchHandlerOptions): EmulatorServeError | undefined => {
  if (options.host !== undefined && options.host !== emulatorServerHost) {
    return new EmulatorServeError({ reason: 'host-not-allowed' })
  }

  const port = options.port ?? 0

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return new EmulatorServeError({ reason: 'invalid-port' })
  }

  return undefined
}

const readBody = (incoming: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []

    incoming.on('data', (chunk: Buffer | string) => {
      chunks.push(Predicate.isString(chunk) ? Buffer.from(chunk) : chunk)
    })
    incoming.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    incoming.on('error', reject)
  })

const toWebRequest = async (incoming: IncomingMessage, origin: string): Promise<Request> => {
  const headers = new Headers()

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }

  const method = incoming.method ?? 'GET'
  const body = await readBody(incoming)
  const init: RequestInit = { method, headers }

  if (method !== 'GET' && method !== 'HEAD' && body.byteLength > 0) {
    init.body = body
  }

  return new Request(new URL(incoming.url ?? '/', origin), init)
}

const waitForDrain = (outgoing: ServerResponse): Promise<void> =>
  new Promise(resolve => {
    const done = () => {
      outgoing.off('drain', done)
      outgoing.off('close', done)
      resolve()
    }

    outgoing.on('drain', done)
    outgoing.on('close', done)
  })

/**
 * Write a web `Response` to a Node response: status and headers first, then
 * each body chunk as soon as the handler produces it. A body stream error
 * destroys the socket mid-response.
 */
const writeResponse = async (outgoing: ServerResponse, response: Response): Promise<void> => {
  outgoing.statusCode = response.status

  if (response.statusText.length > 0) {
    outgoing.statusMessage = response.statusText
  }

  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') outgoing.setHeader(name, value)
  })

  const cookies = response.headers.getSetCookie()

  if (cookies.length > 0) {
    outgoing.setHeader('set-cookie', cookies)
  }

  if (response.body === null) {
    outgoing.end()

    return
  }

  outgoing.flushHeaders()

  const reader = response.body.getReader()

  outgoing.on('close', () => {
    if (!outgoing.writableFinished) {
      reader.cancel().catch(() => undefined)
    }
  })

  const pump = async (): Promise<void> => {
    const { done, value } = await reader.read()

    if (done || outgoing.destroyed) {
      outgoing.end()

      return
    }

    if (!outgoing.write(value)) {
      await waitForDrain(outgoing)
    }

    return pump()
  }

  // Destroy without an error argument: the client sees a dropped connection, and no unhandled
  // 'error' event is emitted on the response.
  await pump().catch(() => {
    outgoing.destroy()
  })
}

const handleRequest = (
  handler: FetchHandler,
  origin: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<void> =>
  toWebRequest(incoming, origin)
    .then(handler)
    .then(
      response => writeResponse(outgoing, response),
      () => {
        if (outgoing.headersSent) {
          outgoing.destroy()

          return
        }

        outgoing.statusCode = 500
        outgoing.setHeader('content-type', 'text/plain')
        outgoing.end('emulator handler failed')
      }
    )
    // A response that cannot be written (for example an invalid header value) drops the connection.
    .catch(() => {
      outgoing.destroy()
    })

/**
 * Serve a fetch handler on `127.0.0.1` (Promise variant, for hosts without an
 * Effect runtime). Rejects with `EmulatorServeError` for a non-loopback host,
 * an invalid port, or a listen failure.
 */
export const startFetchHandlerServer = (
  handler: FetchHandler,
  options: ServeFetchHandlerOptions = {}
): Promise<RunningFetchHandlerServer> => {
  const invalid = validateOptions(options)

  if (invalid !== undefined) {
    return Promise.reject(invalid)
  }

  const sockets = new Set<Socket>()
  const server = createServer()
  let origin = ''

  server.on('connection', socket => {
    socket.setNoDelay(true)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('request', (incoming: IncomingMessage, outgoing: ServerResponse) => {
    void handleRequest(handler, origin, incoming, outgoing)
  })

  let closing: Promise<void> | undefined

  const close = (): Promise<void> => {
    closing ??= new Promise(resolve => {
      server.close(() => resolve())

      for (const socket of sockets) socket.destroy()
    })

    return closing
  }

  return new Promise((resolve, reject) => {
    server.once('error', cause =>
      reject(new EmulatorServeError({ reason: 'listen-failed', cause }))
    )
    server.listen(options.port ?? 0, emulatorServerHost, () => {
      const address = server.address()

      if (address === null || Predicate.isString(address)) {
        void close()
        reject(new EmulatorServeError({ reason: 'listen-failed' }))

        return
      }

      origin = `http://${emulatorServerHost}:${address.port}`
      resolve({ url: origin, close })
    })
  })
}

/**
 * Serve a fetch handler on `127.0.0.1` as a scoped resource: the server
 * closes when the scope closes (or earlier via `close`). Fails with
 * `EmulatorServeError` for a non-loopback host, an invalid port, or a listen
 * failure.
 */
export const serveFetchHandler = (
  handler: FetchHandler,
  options: ServeFetchHandlerOptions = {}
): Effect.Effect<ServedFetchHandler, EmulatorServeError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const invalid = validateOptions(options)

      return invalid === undefined
        ? Effect.tryPromise({
            try: () => startFetchHandlerServer(handler, options),
            catch: cause =>
              cause instanceof EmulatorServeError
                ? cause
                : new EmulatorServeError({ reason: 'listen-failed', cause })
          })
        : Effect.fail(invalid)
    }),
    server => Effect.promise(() => server.close())
  ).pipe(Effect.map(server => ({ url: server.url, close: Effect.promise(() => server.close()) })))
