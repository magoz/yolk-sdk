import { readFile } from 'node:fs/promises'

const statePath = '.alchemy/state/YolkAgentWorker/dev_magoz/Api.json'
const timeoutMs = 10_000

type SmokeEvent = {
  readonly _tag: string
  readonly text?: string
  readonly message?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)

const requireString = (value: unknown, label: string) => {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  throw new Error(`Missing ${label}`)
}

const readDeployedUrl = async () => {
  const configuredUrl = optionalString(process.env.CLOUDFLARE_AGENT_URL)

  if (configuredUrl !== undefined) {
    return configuredUrl
  }

  const raw = await readFile(statePath, 'utf8')
  const parsed: unknown = JSON.parse(raw)

  if (!isRecord(parsed) || !isRecord(parsed.attr)) {
    throw new Error(`Missing attr.url in ${statePath}`)
  }

  return requireString(parsed.attr.url, 'attr.url')
}

const websocketUrl = (url: string, sessionId: string) => {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  parsed.pathname = `/connect/${sessionId}`
  return parsed.toString()
}

const decodeSmokeEvent = (data: MessageEvent['data']): SmokeEvent => {
  if (typeof data !== 'string') {
    return { _tag: 'UnknownBinary' }
  }

  const parsed: unknown = JSON.parse(data)

  if (!isRecord(parsed)) {
    return { _tag: 'UnknownJson' }
  }

  return {
    _tag: requireString(parsed._tag, '_tag'),
    text: optionalString(parsed.text),
    message: optionalString(parsed.message)
  }
}

const smokeWebSocket = (url: string) =>
  new Promise<ReadonlyArray<SmokeEvent>>((resolve, reject) => {
    const sessionId = `smoke-${Date.now()}`
    const input = `hello ${sessionId}`
    const expectedText = `faux-cloudflare: ${input}`
    const events: Array<SmokeEvent> = []
    let collectedText = ''
    let settled = false
    const socket = new WebSocket(websocketUrl(url, sessionId))
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        socket.close()
        reject(new Error(`Timed out waiting for AgentEnd; collected=${collectedText}`))
      }
    }, timeoutMs)

    const settle = (result: Error | ReadonlyArray<SmokeEvent>) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      socket.close()

      if (result instanceof Error) {
        reject(result)
      } else {
        resolve(result)
      }
    }

    socket.addEventListener('open', () => {
      socket.send(input)
    })

    socket.addEventListener('error', () => {
      settle(new Error('WebSocket error'))
    })

    socket.addEventListener('message', event => {
      try {
        const decoded = decodeSmokeEvent(event.data)
        events.push(decoded)

        if (decoded._tag === 'LLMTextDelta' && decoded.text !== undefined) {
          collectedText = `${collectedText}${decoded.text}`
        }

        if (decoded._tag === 'AgentError') {
          settle(new Error(decoded.message ?? 'AgentError'))
          return
        }

        if (decoded._tag === 'AgentEnd') {
          if (collectedText !== expectedText) {
            settle(new Error(`Unexpected text: ${collectedText}`))
            return
          }

          settle(events)
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })

const main = async () => {
  const url = await readDeployedUrl()
  const health = await fetch(`${url}/health`)

  if (!health.ok) {
    throw new Error(`Health failed: ${health.status}`)
  }

  const body = await health.text()

  if (body !== 'ok') {
    throw new Error(`Unexpected health body: ${body}`)
  }

  const events = await smokeWebSocket(url)

  console.log(`ok ${url}`)
  console.log(`events ${events.map(event => event._tag).join(' ')}`)
}

await main()
