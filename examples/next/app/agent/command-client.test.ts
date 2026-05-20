import { Effect, Layer } from 'effect'
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { loadAgentCommands, renderAgentCommand } from './command-client'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeHttpClientLayer = (response: Response, requests: Array<CapturedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.request.body
  expect(body?._tag).toBe('Uint8Array')

  if (body?._tag !== 'Uint8Array') {
    expect.fail('Expected command request body to be text')
  }

  return new TextDecoder().decode(body.body)
}

describe('command client', () => {
  it.effect('loads command summaries', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const commands = yield* loadAgentCommands({
        httpClientLayer: makeHttpClientLayer(
          new Response(
            JSON.stringify({
              commands: [
                {
                  name: 'review',
                  description: 'Review changes',
                  hints: ['$ARGUMENTS'],
                  arguments: [{ name: 'path', required: true }],
                  access: 'read',
                  fileRefs: true
                }
              ]
            })
          ),
          requests
        )
      })

      expect(requests[0]?.request.url).toBe('/api/agent/commands')
      expect(requests[0]?.request.method).toBe('GET')
      expect(commands).toEqual([
        {
          name: 'review',
          description: 'Review changes',
          hints: ['$ARGUMENTS'],
          arguments: [{ name: 'path', required: true }],
          access: 'read',
          fileRefs: true
        }
      ])
    })
  )

  it.effect('renders a command prompt', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const content = yield* renderAgentCommand('review', 'app/agent', {
        httpClientLayer: makeHttpClientLayer(
          new Response(JSON.stringify({ content: 'Review app/agent' })),
          requests
        )
      })

      const headers = requests[0]?.request.headers
      expect(requests[0]?.request.url).toBe('/api/agent/commands')
      expect(requests[0]?.request.method).toBe('POST')
      expect(
        headers === undefined ? undefined : Headers.get(headers, 'content-type')
      ).toMatchObject({
        _tag: 'Some',
        value: 'application/json'
      })
      expect(readCapturedBody(requests)).toBe(
        JSON.stringify({ command: 'review', arguments: 'app/agent' })
      )
      expect(content).toBe('Review app/agent')
    })
  )
})
