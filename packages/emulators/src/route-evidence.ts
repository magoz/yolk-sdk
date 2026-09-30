/**
 * Route evidence manifests shared by the emulators (internal; re-exported as
 * types by each emulator subpath).
 *
 * Emulators never import SDK code. Each emulated route instead names the
 * conformance case ids whose recorded wire shapes it follows, and how well
 * that shape is backed: `verified` routes follow a live observation (dated by
 * `observedAt`), `unverified` routes follow synthetic placeholders. The repo
 * evidence check (`pnpm packages:evidence`) validates the case ids.
 */
import { Data } from 'effect'

/** How well an emulated route's wire shape is backed by live observation. */
export type EmulatorEvidence = 'verified' | 'unverified'

/** One emulated route and the conformance evidence behind its wire shape. */
export type EmulatorRouteEvidence = {
  readonly method: string
  /** Path template, for example `/v1/chat/completions` or `/3/invoices/{DocumentNumber}`. */
  readonly path: string
  /** `provider` for model/provider APIs, `connector` for connector APIs. */
  readonly kind: 'provider' | 'connector'
  /** True when the route changes state in the real service. */
  readonly write: boolean
  /** Conformance case ids whose wire claims this route follows. */
  readonly caseIds: ReadonlyArray<string>
  readonly evidence: EmulatorEvidence
  /** Calendar date (`YYYY-MM-DD`, UTC) of the live observation behind `verified` evidence. */
  readonly observedAt?: string | undefined
}

/** Response header carried by every response from an unverified route. */
export const emulatorEvidenceHeader = 'x-emulator-evidence'

/** `METHOD /path` key for a manifest route. */
export const emulatorRouteKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path}`

/**
 * An emulator's manifest and its handlers disagree: a manifest route has no
 * handler, or a handler has no manifest route. A bug in the emulator, thrown
 * when the emulator is constructed.
 */
export class EmulatorRouteUnmapped extends Data.TaggedError('EmulatorRouteUnmapped')<{
  readonly route: string
  readonly problem: 'no-handler' | 'no-manifest-route'
}> {
  override get message(): string {
    return this.problem === 'no-handler'
      ? `Emulator manifest route ${this.route} has no handler`
      : `Emulator handler ${this.route} has no manifest route`
  }
}

export type BoundEmulatorRoute<H> = {
  readonly route: EmulatorRouteEvidence
  readonly handler: H
}

/**
 * Pair every manifest route with its own handler (keyed by
 * `emulatorRouteKey`). Throws `EmulatorRouteUnmapped` when a manifest route
 * has no handler or a handler has no manifest route, so a manifest entry can
 * never be served by another route's handler.
 */
export const bindRouteHandlers = <H>(
  routes: ReadonlyArray<EmulatorRouteEvidence>,
  handlers: ReadonlyMap<string, H>
): ReadonlyArray<BoundEmulatorRoute<H>> => {
  const bound = routes.map(route => {
    const key = emulatorRouteKey(route.method, route.path)
    const handler = handlers.get(key)

    if (handler === undefined) {
      throw new EmulatorRouteUnmapped({ route: key, problem: 'no-handler' })
    }

    return { route, handler }
  })

  const manifestKeys = new Set(routes.map(route => emulatorRouteKey(route.method, route.path)))

  for (const key of handlers.keys()) {
    if (!manifestKeys.has(key)) {
      throw new EmulatorRouteUnmapped({ route: key, problem: 'no-manifest-route' })
    }
  }

  return bound
}
