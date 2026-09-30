/**
 * Composition of several kernel-built emulators behind one origin (internal; not a package
 * export).
 *
 * The router takes one route per origin, so every route of one service origin must be answered by
 * one fetch handler. When an origin carries routes of different wire cores (OpenCode Go serves
 * Chat Completions, Messages, Responses, and usage under `https://opencode.ai`; Anthropic, Codex,
 * and Grok serve their subscription-usage route next to their model route), each core keeps its
 * own manifest, ledger, faults, turns, and control plane, and this module dispatches by path:
 *
 * - an API request whose path is a part's route path goes to that part; any other API request goes
 *   to the fallback part (which fails it closed as an unknown route and records it);
 * - `/_emulate/<part>/...` is that part's control plane (`/_emulate/...` inside the part);
 * - `POST /_emulate/reset` resets every part.
 *
 * Runtime-portable Web APIs only; no Node builtins and no SDK imports.
 */
import { controlError, jsonResponse, type EmulatorCoverage } from './emulator-kernel.ts'

/** What composition needs from each emulator. */
export type ComposedPart = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly reset: () => void
  readonly coverage: () => EmulatorCoverage
}

export type ComposedRoute = {
  /** Control-plane name: `/_emulate/<name>/...`. */
  readonly name: string
  /** API paths this part answers (its manifest paths). */
  readonly paths: ReadonlyArray<string>
  readonly part: ComposedPart
}

const requestPath = (request: Request): string =>
  URL.canParse(request.url) ? new URL(request.url).pathname : '/'

/** `/_emulate/<name>[/rest]` as the part's own control-plane path, or undefined. */
const partControlPath = (path: string, name: string): string | undefined => {
  const prefix = `/_emulate/${name}`

  if (path === prefix) return '/_emulate'

  return path.startsWith(`${prefix}/`) ? `/_emulate${path.slice(prefix.length)}` : undefined
}

/** Re-send a control-plane request to a part under its own control-plane path. */
const forwardControl = async (
  request: Request,
  part: ComposedPart,
  path: string
): Promise<Response> => {
  const url = new URL(request.url)

  url.pathname = path

  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()

  return part.fetch(new Request(url, { method: request.method, headers: request.headers, body }))
}

export const isControlPlanePath = (path: string): boolean =>
  path === '/_emulate' || path.startsWith('/_emulate/')

/** Every part's coverage in route order, with the unknown-route counts summed. */
export const combinedCoverage = (parts: ReadonlyArray<ComposedPart>): EmulatorCoverage => {
  const coverages = parts.map(part => part.coverage())

  return {
    routes: coverages.flatMap(coverage => coverage.routes),
    unknownRouteRequests: coverages.reduce(
      (total, coverage) => total + coverage.unknownRouteRequests,
      0
    )
  }
}

export type ComposedFetchOptions = {
  readonly routes: ReadonlyArray<ComposedRoute>
  /** Answers API requests on no part's path (and fails them closed). */
  readonly fallback: ComposedPart
  /**
   * Answers the remaining `/_emulate/*` requests (not a part's prefix, not `POST
   * /_emulate/reset`). Defaults to a 404 control error.
   */
  readonly control?: (request: Request, path: string) => Promise<Response>
}

/** One fetch handler over several parts. Never rejects. */
export const composeFetch =
  (options: ComposedFetchOptions) =>
  (request: Request): Promise<Response> => {
    const handle = async (): Promise<Response> => {
      const path = requestPath(request)

      if (!isControlPlanePath(path)) {
        const route = options.routes.find(candidate => candidate.paths.includes(path))

        return (route?.part ?? options.fallback).fetch(request)
      }

      for (const route of options.routes) {
        const partPath = partControlPath(path, route.name)

        if (partPath !== undefined) return forwardControl(request, route.part, partPath)
      }

      if (path === '/_emulate/reset' && request.method === 'POST') {
        options.fallback.reset()

        for (const route of options.routes) route.part.reset()

        return jsonResponse(200, { reset: true })
      }

      return options.control === undefined
        ? controlError(404, 'unknown control-plane route')
        : options.control(request, path)
    }

    return handle().catch(() => controlError(500, 'emulator failed to handle the request'))
  }

/**
 * A wire-core emulator with its subscription-usage route on the same origin: `path` goes to
 * `usage`, `/_emulate/usage/...` is the usage control plane, `POST /_emulate/reset` and `reset()`
 * reset both, and everything else (other API paths, other `/_emulate/*` routes) is the primary
 * emulator's, unchanged. The primary's ledger, faults, script, and coverage stay its own.
 */
export const withSubscriptionUsage = <Primary extends ComposedPart, Usage extends ComposedPart>(
  primary: Primary,
  usage: Usage,
  path: string
): Primary & { readonly usage: Usage } => ({
  ...primary,
  fetch: composeFetch({
    routes: [{ name: 'usage', paths: [path], part: usage }],
    fallback: primary,
    control: request => primary.fetch(request)
  }),
  reset: () => {
    primary.reset()
    usage.reset()
  },
  usage
})
