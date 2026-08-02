import { Effect } from 'effect'
import type { FetchLike } from '@modelcontextprotocol/client'
import { HttpClientRequest } from 'effect/unstable/http'
import type { HttpClient } from 'effect/unstable/http'

const makeRequest = (request: Request) => {
  switch (request.method) {
    case 'DELETE':
      return HttpClientRequest.delete(request.url)
    case 'GET':
      return HttpClientRequest.get(request.url)
    case 'HEAD':
      return HttpClientRequest.head(request.url)
    case 'OPTIONS':
      return HttpClientRequest.options(request.url)
    case 'PATCH':
      return HttpClientRequest.patch(request.url)
    case 'POST':
      return HttpClientRequest.post(request.url)
    case 'PUT':
      return HttpClientRequest.put(request.url)
    default:
      throw new TypeError(`Unsupported HTTP method: ${request.method}`)
  }
}

const hasResponseBody = (request: Request, status: number) =>
  request.method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304

export const makeEffectFetch =
  (http: HttpClient.HttpClient): FetchLike =>
  async (input, init) => {
    const webRequest = new Request(input, init)
    const bytes =
      webRequest.method === 'GET' || webRequest.method === 'HEAD'
        ? undefined
        : new Uint8Array(await webRequest.arrayBuffer())
    const headers: Record<string, string> = {}
    webRequest.headers.forEach((value, key) => {
      headers[key] = value
    })
    let request = makeRequest(webRequest).pipe(HttpClientRequest.setHeaders(headers))

    if (bytes !== undefined && bytes.length > 0) {
      request = HttpClientRequest.bodyUint8Array(
        request,
        bytes,
        webRequest.headers.get('content-type') ?? undefined
      )
    }

    const response = await Effect.runPromise(http.execute(request), { signal: webRequest.signal })
    const body = hasResponseBody(webRequest, response.status)
      ? new Uint8Array(await Effect.runPromise(response.arrayBuffer))
      : undefined

    return new Response(body, {
      status: response.status,
      headers: Object.entries(response.headers)
    })
  }
