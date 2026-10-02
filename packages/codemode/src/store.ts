import { Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { CodeModeStore, CodeModeStoreWrites } from './executor.ts'
import { codeModeToolName } from './tool.ts'

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

/** Largest stored value: characters of JSON (256 KiB), as the pi engine counts them. */
export const maxCodeModeStoreValueChars = 256 * 1024

/** Largest store: characters of keys plus JSON values (1 MiB), as the pi engine counts them. */
export const maxCodeModeStoreTotalChars = 1024 * 1024

/** One prior tool result with the name of the tool that produced it. */
export type CodeModeToolResultEntry = {
  readonly toolName: string
  readonly result: { readonly structuredContent?: unknown }
}

/**
 * Rebuilds the code mode store from prior tool results, oldest first: applies the `storeWrites` of
 * each successful script of the code mode tool named `toolName` (default `codemode`) in order.
 * Results of other tools (even when their `structuredContent` looks like a code mode result),
 * failed scripts, and malformed contents are skipped. Transcript `ToolResultMessage`s carry no tool
 * name; pair each with the name of its assistant tool call.
 *
 * The rebuilt store keeps the engine bounds: a write whose JSON value exceeds 256 Ki characters, or
 * that would grow the store beyond 1 Mi characters (keys plus JSON values), is dropped and the key
 * keeps its previous value. Deletions always apply. Pass the value from `loadStore`.
 */
export const codeModeStoreFromToolResults = (
  entries: ReadonlyArray<CodeModeToolResultEntry>,
  options: { readonly toolName?: string } = {}
): CodeModeStore => {
  const toolName = options.toolName ?? codeModeToolName
  const store = new Map<string, { readonly value: Schema.Json; readonly chars: number }>()
  let total = 0

  for (const entry of entries) {
    if (entry.toolName !== toolName) continue

    const content = decodeStructuredContent(entry.result.structuredContent)

    if (Option.isNone(content) || !content.value.codemode.ok) continue

    const writes = content.value.codemode.storeWrites

    if (writes === undefined) continue

    for (const key of writes.delete) {
      total -= store.get(key)?.chars ?? 0
      store.delete(key)
    }

    for (const [key, value] of Object.entries(writes.set)) {
      const json = JSON.stringify(value)

      if (json.length > maxCodeModeStoreValueChars) continue

      const chars = key.length + json.length
      const next = total - (store.get(key)?.chars ?? 0) + chars

      if (next > maxCodeModeStoreTotalChars) continue

      store.set(key, { value, chars })
      total = next
    }
  }

  return Object.fromEntries([...store].map(([key, stored]) => [key, stored.value]))
}
