import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import * as Schema from 'effect/Schema'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const Manifest = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Unknown) })

const decodeSourceExport = Schema.decodeUnknownOption(Schema.Struct({ default: Schema.String }))

const manifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(
  readFileSync(join(packageDir, 'package.json'), 'utf8')
)

/** The source file a `@yolk-sdk/agent/*` specifier resolves to (`package.json` exports). */
const selfExport = (specifier: string) =>
  manifest.pipe(
    Option.flatMap(({ exports }) =>
      Option.fromNullishOr(exports[`.${specifier.slice('@yolk-sdk/agent'.length)}`])
    ),
    Option.flatMap(decodeSourceExport),
    Option.map(target => join(packageDir, target.default)),
    Option.getOrUndefined
  )

const importSpecifiers = (source: string) =>
  [
    ...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gmu),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].flatMap(match => (match[1] === undefined ? [] : [match[1]]))

/**
 * Every module specifier the entry file reaches through static and literal dynamic imports, type
 * imports included (a declaration that names React types needs React's types too). Package
 * self-imports and relative imports are followed; other packages are recorded, not followed.
 */
const reachableSpecifiers = (entry: string) => {
  const files = new Set<string>()
  const external = new Set<string>()
  const pending = [entry]

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue

    files.add(file)

    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      const next = specifier.startsWith('.')
        ? resolve(dirname(file), specifier)
        : specifier.startsWith('@yolk-sdk/agent')
          ? selfExport(specifier)
          : undefined

      if (next === undefined) external.add(specifier)
      else pending.push(next)
    }
  }

  return { files, external }
}

describe('@yolk-sdk/agent/chat', () => {
  it('reaches no React module, by any import', () => {
    expect(Option.isSome(manifest)).toBe(true)

    const { files, external } = reachableSpecifiers(join(packageDir, 'src/chat/index.ts'))

    expect([...files].some(file => file.includes('/src/chat/chat-core.ts'))).toBe(true)
    expect([...files].filter(file => file.includes('/src/react/'))).toEqual([])
    expect([...external].filter(specifier => /^react(?:\/|-dom|$)/u.test(specifier))).toEqual([])
  })

  it('is what `@yolk-sdk/agent/react` re-exports, with the hook added', async () => {
    const [chat, react] = await Promise.all([
      import('@yolk-sdk/agent/chat'),
      import('@yolk-sdk/agent/react')
    ])

    const reactExports = new Map(Object.entries(react))

    for (const [name, value] of Object.entries(chat)) {
      expect(reactExports.get(name), name).toBe(value)
    }

    expect(Object.keys(react).filter(name => !(name in chat))).toEqual(['useAgentChat'])
  })
})
