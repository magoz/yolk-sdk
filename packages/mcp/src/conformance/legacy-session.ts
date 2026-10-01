import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { legacyListingExchanges, mcpSyntheticFixture } from './synthetic.ts'

/**
 * The legacy handshake with session `yolk-synthetic-session-0001`, echoed on every later request:
 * `notifications/initialized` answered 202 and the standing GET answered 405.
 */
export const mcpLegacySessionFixture: WireFixture = mcpSyntheticFixture({
  caseId: 'mcp.legacy.session',
  era: 'legacy',
  note: 'initialize issues a synthetic session id that every later request echoes; initialized gets 202 and GET gets 405.',
  exchanges: legacyListingExchanges()
})
