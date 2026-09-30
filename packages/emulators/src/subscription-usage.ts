/**
 * Subscription-usage routes (internal; not a package export): one `GET` route per usage endpoint
 * the SDK fetchers call (Claude, Codex, Grok, OpenCode Go), on the fixture-only core
 * (`fixture-route.ts`). A request carrying the credential and headers the fetcher sends, on the
 * recorded query, gets the recorded snapshot body; everything else answers 400 not-emulated. The
 * body may be replaced (`subscriptionUsage` option, scripted `{ usage }` turn) only by a body with
 * the recorded JSON shape.
 *
 * Usage routes live next to a model route on the same origin (`/anthropic`, `/codex`, `/xai`,
 * `/opencode`), but keep their own manifest, ledger, faults, and turns, so the model route's
 * manifest and coverage are unchanged; `emulator-compose.ts` dispatches to them.
 */
import type * as Schema from 'effect/Schema'
import {
  FixtureRouteFault,
  makeFixtureRouteEmulator,
  type FixtureRecording,
  type FixtureRouteEmulator,
  type FixtureRouteFaultKind,
  type FixtureRouteHeaderRule,
  type FixtureRouteLedgerEntry,
  type FixtureRouteScriptedTurn
} from './fixture-route.ts'
import { parseJson } from './emulator-kernel.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'

/** Usage-route faults: `status`, `error-after-chunks`, `truncate-after-chunks` (one-chunk body). */
export const SubscriptionUsageFault = FixtureRouteFault

export type SubscriptionUsageFault = FixtureRouteFault

export type SubscriptionUsageFaultKind = FixtureRouteFaultKind

/** A usage turn: `{ usage }` (a body with the recorded JSON shape) or `{ error }`. */
export type SubscriptionUsageScriptedTurn = FixtureRouteScriptedTurn

export type SubscriptionUsageLedgerEntry = FixtureRouteLedgerEntry

export type SubscriptionUsageEmulator = FixtureRouteEmulator

export type SubscriptionUsageEmulatorConfig = {
  readonly path: string
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  readonly recording: FixtureRecording
  /** Headers the SDK fetcher sends besides `Authorization: Bearer` and `accept`, in order. */
  readonly headers: ReadonlyArray<FixtureRouteHeaderRule>
  /** Replacement default body; must have the recorded JSON shape. */
  readonly subscriptionUsage: Schema.Json | undefined
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
}

/** The recorded snapshot body of a usage recording, parsed. */
export const recordedUsageBody = (recording: FixtureRecording): Schema.Json =>
  parseJson(recording.response.chunks.join('')) ?? null

export const makeSubscriptionUsageEmulator = (
  config: SubscriptionUsageEmulatorConfig
): SubscriptionUsageEmulator =>
  makeFixtureRouteEmulator({
    method: 'GET',
    path: config.path,
    routes: config.routes,
    recordings: [config.recording],
    credential: 'bearer',
    headers: config.headers,
    replaceableBody: { defaultBody: config.subscriptionUsage },
    inputInvalid: config.inputInvalid
  })
