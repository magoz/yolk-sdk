import { readFileSync } from 'node:fs'
import { Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import { PRELUDE_SOURCE } from '../src/pi-prelude.ts'

// `src/pi-prelude.ts` is a copy of pi's in-VM prelude, which pi does not export. When this fails,
// the installed `@earendil-works/pi-codemode` changed it: copy the new text (and its header's
// version) into `src/pi-prelude.ts`, and check `src/cloudflare.ts` still matches its protocol.

const installedPreludeUrl = new URL(
  './runtime/prelude-source.js',
  import.meta.resolve('@earendil-works/pi-codemode')
)

describe('vendored pi prelude', () => {
  it('matches the installed pi-codemode prelude', async () => {
    const installedModule: unknown = await import(/* @vite-ignore */ installedPreludeUrl.href)

    const installed = Predicate.hasProperty(installedModule, 'PRELUDE_SOURCE')
      ? installedModule.PRELUDE_SOURCE
      : undefined

    expect(PRELUDE_SOURCE).toBe(installed)
  })

  it('has the template text the installed file has', () => {
    const file = readFileSync(installedPreludeUrl, 'utf8')
    const vendored = readFileSync(new URL('../src/pi-prelude.ts', import.meta.url), 'utf8')

    const template = (text: string) =>
      text.slice(text.indexOf('`(function'), text.lastIndexOf('})`') + '})`'.length)

    expect(template(vendored)).toBe(template(file))
  })
})
