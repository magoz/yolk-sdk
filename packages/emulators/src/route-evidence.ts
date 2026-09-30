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
