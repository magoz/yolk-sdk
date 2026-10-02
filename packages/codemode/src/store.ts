import { Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { CodeModeStore, CodeModeStoreWrites } from './executor.ts'

/** `structuredContent` of a code mode `ToolResult`. `storeWrites` is present only for successful
 * scripts that changed the store.
 */
export type CodeModeStructuredContent = {
  readonly codemode: {
    readonly ok: boolean
    readonly storeWrites?: CodeModeStoreWrites
  }
}

const StoreWritesSchema = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.Json),
  delete: Schema.Array(Schema.String)
})

const CodeModeStructuredContentSchema = Schema.Struct({
  codemode: Schema.Struct({
    ok: Schema.Boolean,
    storeWrites: Schema.optionalKey(StoreWritesSchema)
  })
})

const decodeStructuredContent = Schema.decodeUnknownOption(CodeModeStructuredContentSchema)

/**
 * Rebuilds the code mode store from prior code mode results (`ToolResult`s or transcript
 * `ToolResultMessage`s), oldest first: applies the `storeWrites` of each successful script in
 * order. Results of failed scripts and other tools are skipped. Pass the value from `loadStore`.
 */
export const codeModeStoreFromToolResults = (
  results: ReadonlyArray<{ readonly structuredContent?: unknown }>
): CodeModeStore => {
  const store = new Map<string, Schema.Json>()

  for (const result of results) {
    const content = decodeStructuredContent(result.structuredContent)

    if (Option.isNone(content) || !content.value.codemode.ok) continue

    const writes = content.value.codemode.storeWrites

    if (writes === undefined) continue

    for (const key of writes.delete) {
      store.delete(key)
    }

    for (const [key, value] of Object.entries(writes.set)) {
      store.set(key, value)
    }
  }

  return Object.fromEntries(store)
}
