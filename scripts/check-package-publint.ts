import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { publint } from 'publint'
import { formatMessage } from 'publint/utils'

const main = async () => {
  const workspaceRoot = process.cwd()
  const packagesRoot = join(workspaceRoot, 'packages')

  const packageDirs = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(packagesRoot, entry.name))
    .filter(packageDir => existsSync(join(packageDir, 'package.json')))

  const results = await Promise.all(
    packageDirs.map(async packageDir => ({
      packageDir,
      result: await publint({ pkgDir: packageDir, strict: true })
    }))
  )

  const failures = results.flatMap(({ packageDir, result }) =>
    result.messages.map(message => `${packageDir}: ${formatMessage(message, result.pkg)}`)
  )

  if (failures.length > 0) {
    console.error('Package publint failures:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
  }
}

void main()
