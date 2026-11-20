import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { legacyServerPingListingExchanges, mcpSyntheticFixture } from './synthetic.ts'

/**
 * A legacy server that pings during `initialize`: the client answers the ping with an empty result
 * on its own POST, which the server accepts with 202. Spec: MCP `2025-11-25`, basic/utilities/ping
 * ("The receiver MUST respond promptly with an empty response"), basic/transports "Sending Messages
 * to the Server" (items 3, 4 and 6: a client response is a POST answered 202 with no body; the
 * server MAY send requests before the response), basic/lifecycle (pings may precede
 * `notifications/initialized`).
 */
export const mcpServerPingLegacyFixture: WireFixture = mcpSyntheticFixture({
  caseId: 'mcp.legacy.server-ping',
  era: 'legacy',
  note: 'MCP 2025-11-25 basic/utilities/ping, basic/transports (Sending Messages to the Server, items 3, 4 and 6), basic/lifecycle (Initialization): the initialize SSE answer carries a ping request before its response; the client answers it with an empty result on a POST carrying the session, accepted with 202 and no body, then completes the handshake and the listing.',
  exchanges: legacyServerPingListingExchanges()
})
