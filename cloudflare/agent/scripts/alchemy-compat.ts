/**
 * Synchronous Node CLI smoke for Alchemy × catalog Effect.
 *
 * This file is a Node process boundary: `node:child_process`, `node:fs`, and
 * `process.exit` are intentional. Run it with `node --experimental-strip-types`
 * so Node's `import` export condition loads Alchemy `lib/` (the same graph as
 * the `alchemy` CLI), not tsx/bun `src/`.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Namespace from 'alchemy/Namespace'
import * as Effect from 'effect/Effect'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

const agentPackageJson = fileURLToPath(new URL('../package.json', import.meta.url))

const alchemyRoot = fileURLToPath(new URL('..', import.meta.resolve('alchemy')))

const failures: string[] = []

const expectFunction = (name: string, value: unknown) => {
  if (typeof value !== 'function') {
    failures.push(`${name} is ${typeof value}, expected function`)
  }
}

expectFunction('Alchemy.Stack', Alchemy.Stack)

expectFunction('Alchemy.localState', Alchemy.localState)

expectFunction('Cloudflare.Worker', Cloudflare.Worker)

expectFunction('Cloudflare.providers', Cloudflare.providers)

expectFunction('Cloudflare.DurableObjectNamespace', Cloudflare.DurableObjectNamespace)

expectFunction('Cloudflare.upgrade', Cloudflare.upgrade)

if (Namespace.CurrentNamespace === undefined) {
  failures.push('alchemy/Namespace CurrentNamespace is missing')
}

const namespaceOption = Effect.serviceOption(Namespace.Namespace)

if (typeof namespaceOption.pipe !== 'function') {
  failures.push('Effect.serviceOption(Namespace) is not a pipeable Effect')
}

if (typeof Reflect.get(namespaceOption, 'asEffect') === 'function') {
  failures.push(
    'Effect.serviceOption(Namespace).asEffect still exists; catalog Effect is too old for this Alchemy'
  )
}

const resolveEffect = (fromFile: string) => realpathSync(createRequire(fromFile).resolve('effect'))

const effectFromAgent = resolveEffect(agentPackageJson)

const effectFromRoot = resolveEffect(join(repoRoot, 'package.json'))

const effectFromAlchemy = resolveEffect(join(alchemyRoot, 'package.json'))

if (effectFromAgent !== effectFromRoot || effectFromAgent !== effectFromAlchemy) {
  failures.push(
    [
      'Alchemy/app/root resolved different Effect instances:',
      `agent=${effectFromAgent}`,
      `root=${effectFromRoot}`,
      `alchemy=${effectFromAlchemy}`
    ].join(' ')
  )
}

const alchemyBin = join(alchemyRoot, 'bin/cli.js')

const help = spawnSync(process.execPath, [alchemyBin, '--help'], {
  cwd: join(repoRoot, 'cloudflare/agent'),
  encoding: 'utf8',
  timeout: 15_000
})

if (help.error?.name === 'TimeoutError' || help.signal === 'SIGTERM') {
  failures.push('alchemy --help timed out after 15s')
} else if (help.status !== 0) {
  const detail =
    `${help.stderr ?? ''}${help.stdout ?? ''}`.trim() ||
    help.error?.message ||
    `status ${String(help.status)}`

  failures.push(`alchemy --help failed: ${detail}`)
} else if (!help.stdout.toLowerCase().includes('usage')) {
  failures.push('alchemy --help produced no usage output')
}

if (failures.length > 0) {
  console.error(failures.map(failure => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log('alchemy compat ok')

console.log(`effect ${effectFromAgent}`)

console.log(`cli help ${help.status}`)
