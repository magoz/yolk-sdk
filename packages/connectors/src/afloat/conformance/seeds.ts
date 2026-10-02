/**
 * Seeds of the Afloat MCP conformance target. Their shape is the `McpConformanceSeeds` of
 * `@yolk-sdk/mcp/conformance` (this package never imports `@yolk-sdk/mcp`).
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'

/** The structural `McpConformanceSeeds` of an Afloat run. */
export type AfloatMcpConformanceSeeds = {
  readonly readTool?: { readonly name: string; readonly arguments: Schema.JsonObject }
  readonly invalidArguments?: Schema.JsonObject
  readonly expectedTools?: ReadonlyArray<string>
  readonly notReadOnly?: ReadonlyArray<string>
  readonly absentToolName?: string
}

/**
 * The published tool subset the listing must contain, in the provider's listing order: two
 * invoice reads, the download-grant and receipt-upload tools.
 */
export const afloatMcpConformanceExpectedTools: ReadonlyArray<string> = [
  'list-invoices',
  'get-invoice',
  'get-tax-return-download',
  'get-logo-download',
  'create-receipt-upload',
  'complete-receipt-upload',
  'get-receipt-download',
  'get-invoice-pdf',
  'get-quote-pdf'
]

/**
 * The published tools that write, as the provider marks them (`readOnlyHint: false`): the
 * listing must never mark them read-only. The download-grant tools mint a fresh grant on every
 * call but are marked `readOnlyHint: true` by the provider.
 */
export const afloatMcpConformanceNotReadOnly: ReadonlyArray<string> = [
  'create-receipt-upload',
  'complete-receipt-upload'
]

/** The read call of the committed fixtures: one page of ten invoices (read-only, no grant). */
export const afloatMcpConformanceReadCall = {
  name: 'list-invoices',
  arguments: { size: 10 }
} satisfies { readonly name: string; readonly arguments: Schema.JsonObject }

/** Arguments `list-invoices` rejects with a tool error: a page size that is not a number. */
export const afloatMcpConformanceInvalidArguments: Schema.JsonObject = { size: 'ten' }

/**
 * Seeds for a live run: the listing claims only. A live run calls a tool only when a person names
 * one (the runner's `--read-tool`), so these name no `readTool`.
 */
export const afloatMcpConformanceLiveSeeds: AfloatMcpConformanceSeeds = {
  expectedTools: afloatMcpConformanceExpectedTools,
  notReadOnly: afloatMcpConformanceNotReadOnly
}

/** The seeds the committed fixtures replay with (the live seeds plus the synthetic read call). */
export const afloatMcpConformanceFixtureSeeds: AfloatMcpConformanceSeeds = {
  ...afloatMcpConformanceLiveSeeds,
  readTool: afloatMcpConformanceReadCall,
  invalidArguments: afloatMcpConformanceInvalidArguments
}
