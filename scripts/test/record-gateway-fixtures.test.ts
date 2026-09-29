import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { vercelAiGatewayPlainTextFixture } from '../../packages/agent/src/providers/vercel/conformance/index.ts'
import {
  defaultProbeOptions,
  dryRunReport,
  liveAccountRequiredMessage,
  parseProbeArgs,
  plannedGatewayProbeCases,
  renderFixtureModule
} from '../record-gateway-fixtures.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-gateway-fixtures.ts')

describe('record-gateway-fixtures arguments', () => {
  it('defaults to a dry run with documented model ids and no account label', () => {
    expect(parseProbeArgs([])).toEqual(defaultProbeOptions)
    expect(defaultProbeOptions.live).toBe(false)
    expect(defaultProbeOptions.account).toBeUndefined()
  })

  it('requires an explicit --account label with --live', () => {
    expect(() => parseProbeArgs(['--live'])).toThrow(liveAccountRequiredMessage)
    expect(() => parseProbeArgs(['--live', '--plain-model', 'vendor/plain'])).toThrow(
      '--live requires --account <label>'
    )
    expect(parseProbeArgs(['--live', '--account', 'synthetic'])).toMatchObject({
      live: true,
      account: 'synthetic'
    })
    // Dry runs and help do not need a label.
    expect(parseProbeArgs(['--account=synthetic']).live).toBe(false)
    expect(parseProbeArgs(['--live', '--help']).help).toBe(true)
  })

  it('reads flags in both --flag value and --flag=value forms', () => {
    const options = parseProbeArgs([
      '--live',
      '--plain-model',
      'vendor/plain',
      '--reasoning-model=vendor/thinker',
      '--max-tokens=32',
      '--reasoning-effort',
      'high',
      '--account=synthetic'
    ])

    expect(options).toMatchObject({
      live: true,
      plainModel: 'vendor/plain',
      reasoningModel: 'vendor/thinker',
      maxTokens: 32,
      reasoningEffort: 'high',
      account: 'synthetic'
    })
  })

  it('rejects unknown flags, missing values, and invalid numbers', () => {
    expect(() => parseProbeArgs(['--nope'])).toThrow('Unknown argument')
    expect(() => parseProbeArgs(['--tool-model'])).toThrow('requires a value')
    expect(() => parseProbeArgs(['--max-tokens=0'])).toThrow('positive integer')
    expect(() => parseProbeArgs(['--reasoning-effort=extreme'])).toThrow('must be one of')
  })
})

describe('record-gateway-fixtures plan', () => {
  it('plans the four streaming cases with the requested configuration', () => {
    const cases = plannedGatewayProbeCases(defaultProbeOptions)

    expect(cases.map(probe => [probe.caseId, probe.model, probe.expect])).toEqual([
      ['vercel-ai-gateway.stream.plain-text', defaultProbeOptions.plainModel, 'success'],
      [
        'vercel-ai-gateway.stream.deepseek-reasoning',
        defaultProbeOptions.reasoningModel,
        'success'
      ],
      ['vercel-ai-gateway.stream.tool-call-deltas', defaultProbeOptions.toolModel, 'success'],
      ['vercel-ai-gateway.stream.error-envelope', defaultProbeOptions.invalidModel, 'error']
    ])
    expect(cases.every(probe => probe.config.streaming === true)).toBe(true)
    expect(cases[1]?.config).toMatchObject({
      reasoningContent: true,
      reasoningEffortFormat: 'reasoning-effort',
      thinking: { type: 'enabled' }
    })
    expect(cases.map(probe => probe.withTool)).toEqual([false, false, true, false])

    const report = dryRunReport(defaultProbeOptions)

    expect(report).toContain('DRY RUN')
    expect(report).toContain(defaultProbeOptions.invalidModel)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const [plain] = plannedGatewayProbeCases(defaultProbeOptions)

    if (plain === undefined) {
      expect.fail('missing plain-text case')
    }

    const source = renderFixtureModule(plain, vercelAiGatewayPlainTextFixture)

    expect(source).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(source).toContain('export const vercelAiGatewayPlainTextFixture: WireFixture = {')
    expect(source).toContain(`"caseId": "${vercelAiGatewayPlainTextFixture.caseId}"`)
    expect(source).toContain(
      'Regenerate with\n * `pnpm conformance:gateway --live --account <label>`.'
    )
  })
})

describe('record-gateway-fixtures CLI', () => {
  it('dry-runs by default without needing a Gateway key', async () => {
    const result = await new Promise<{ failed: boolean; stdout: string }>(resolvePromise => {
      execFile(
        process.execPath,
        [tsxCli, probeScript],
        { cwd: repoRoot, env: { ...process.env, AI_GATEWAY_API_KEY: '' } },
        (error, stdout) => {
          resolvePromise({ failed: error !== null, stdout: String(stdout) })
        }
      )
    })

    expect(result.failed).toBe(false)
    expect(result.stdout).toContain('DRY RUN: no network request was made')
  })
})
