import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'
import { anthropicClaudeUsageSnapshotFixture } from '../../packages/agent/src/providers/anthropic/conformance/index.ts'
import { openAiCodexUsageSnapshotFixture } from '../../packages/agent/src/providers/openai/conformance/index.ts'
import { xAiGrokUsageSnapshotFixture } from '../../packages/agent/src/providers/xai/conformance/index.ts'
import type { WireFixture } from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import type { FixtureWriter } from '../fixture-probe-internal.ts'
import {
  clientVersionRequiredMessage,
  defaultProbeOptions,
  dryRunReport,
  familyRequiredMessage,
  liveAccountRequiredMessage,
  liveInCiMessage,
  ownerApprovalRequiredMessage,
  parseProbeArgs,
  renderFixtureModule,
  usageFamilies,
  verifyUsageFixtures,
  writeVerifiedFixture,
  type ProbeOptions,
  type UsageFamily
} from '../record-usage-fixtures.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-usage-fixtures.ts')

const families: ReadonlyArray<{
  readonly family: UsageFamily
  readonly fixture: WireFixture
  readonly dir: string
}> = [
  {
    family: 'claude',
    fixture: anthropicClaudeUsageSnapshotFixture,
    dir: 'providers/anthropic/conformance'
  },
  {
    family: 'codex',
    fixture: openAiCodexUsageSnapshotFixture,
    dir: 'providers/openai/conformance'
  },
  { family: 'grok', fixture: xAiGrokUsageSnapshotFixture, dir: 'providers/xai/conformance' }
]

const optionsFor = (family: UsageFamily): ProbeOptions => ({ ...defaultProbeOptions, family })

const withBody = (fixture: WireFixture, body: string): WireFixture => ({
  ...fixture,
  exchanges: [
    {
      request: fixture.exchanges[0].request,
      response: { status: 200, headers: { 'content-type': 'application/json' }, body }
    }
  ]
})

const recordingWriter = () => {
  const calls: Array<{ kind: 'write' | 'format'; paths: ReadonlyArray<string> }> = []

  const writer: FixtureWriter = {
    writeFile: path => {
      calls.push({ kind: 'write', paths: [path] })
    },
    formatFiles: paths => {
      calls.push({ kind: 'format', paths: [...paths] })
    }
  }

  return { calls, writer }
}

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')

describe('record-usage-fixtures arguments', () => {
  it('needs a family and defaults to a dry run', () => {
    expect(() => parseProbeArgs([])).toThrow(familyRequiredMessage)
    expect(() => parseProbeArgs(['--family', 'gemini'])).toThrow('Unknown family')
    expect(parseProbeArgs(['--family', 'codex'])).toEqual(optionsFor('codex'))
    expect(parseProbeArgs(['--family=grok'])).toEqual(optionsFor('grok'))
    expect(parseProbeArgs(['--help']).help).toBe(true)
    expect(usageFamilies.claude.tokenEnv).toBe('ANTHROPIC_CLAUDE_ACCESS_TOKEN')
    expect(usageFamilies.codex.accountEnv).toBe('OPENAI_CODEX_ACCOUNT_ID')
    expect(usageFamilies.grok.accountEnv).toBe('XAI_GROK_USER_ID')
  })

  it('requires owner approval, an account label, and (Grok) a client version with --live', () => {
    expect(() => parseProbeArgs(['--family', 'claude', '--live'])).toThrow(
      ownerApprovalRequiredMessage
    )
    expect(() => parseProbeArgs(['--family', 'claude', '--live', '--owner-approved'])).toThrow(
      liveAccountRequiredMessage
    )
    expect(() =>
      parseProbeArgs(['--family', 'grok', '--live', '--owner-approved', '--account=synthetic'])
    ).toThrow(clientVersionRequiredMessage)
    expect(
      parseProbeArgs([
        '--family',
        'grok',
        '--live',
        '--owner-approved',
        '--account=synthetic',
        '--client-version',
        '1.2.3-host'
      ])
    ).toMatchObject({ live: true, clientVersion: '1.2.3-host' })
  })

  it('refuses --live whenever CI is set to a non-empty value', () => {
    const live = ['--family', 'claude', '--live', '--owner-approved', '--account', 'synthetic']

    for (const CI of ['true', '1', '0', 'false']) {
      expect(() => parseProbeArgs(live, { CI })).toThrow(liveInCiMessage)
    }

    expect(parseProbeArgs(live, { CI: '' }).live).toBe(true)
  })
})

describe('record-usage-fixtures plan, verification, and write gate', () => {
  for (const family of families) {
    const options = optionsFor(family.family)
    const spec = usageFamilies[family.family]

    it(`${family.family}: dry-runs its case, endpoint, and credentials`, () => {
      const report = dryRunReport(options)

      expect(report).toContain('DRY RUN: no network request was made and no credential was read')
      expect(report).toContain(spec.caseId)
      expect(report).toContain(spec.endpoint)
      expect(report).toContain(spec.tokenEnv)
      expect(spec.caseId).toBe(family.fixture.caseId)
      expect(spec.endpoint).toBe(family.fixture.endpoint)
      expect(renderFixtureModule(options, family.fixture)).toContain(
        `export const ${spec.exportName}: WireFixture = {`
      )
    })

    it(`${family.family}: writes the verified fixture module only after replay passes`, async () => {
      const report = await Effect.runPromise(verifyUsageFixtures([family.fixture], options))

      expect(conformanceReportFailed(report)).toBe(false)

      const { calls, writer } = recordingWriter()

      const result = await Effect.runPromise(writeVerifiedFixture(family.fixture, options, writer))

      expect(result.files.map(file => basename(file))).toEqual([spec.fileName])
      expect(result.files[0]).toContain(family.dir)
      expect(calls).toEqual([
        { kind: 'write', paths: result.files },
        { kind: 'format', paths: result.files }
      ])
    })

    it(`${family.family}: writes nothing for a failing, unredacted, or unscannable recording`, async () => {
      for (const [fixture, message] of [
        [withBody(family.fixture, '{}'), 'no fixture was written'],
        [withBody(family.fixture, '{"email":["someone"]}'), 'could not redact email'],
        [withBody(family.fixture, 'not json'), 'could not check 1 response payload']
      ] as const) {
        const { calls, writer } = recordingWriter()
        const exit = await Effect.runPromiseExit(writeVerifiedFixture(fixture, options, writer))

        expect(failureText(exit)).toContain(message)
        expect(calls).toEqual([])
      }

      const other = families.find(candidate => candidate.family !== family.family)
      const { calls, writer } = recordingWriter()

      const exit = await Effect.runPromiseExit(
        writeVerifiedFixture(other?.fixture ?? expect.fail('no other family'), options, writer)
      )

      expect(failureText(exit)).toContain(`the recording is not for ${spec.caseId}`)
      expect(calls).toEqual([])
    })
  }
})

const runCli = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, probeScript, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: '',
          ANTHROPIC_CLAUDE_ACCESS_TOKEN: '',
          OPENAI_CODEX_ACCESS_TOKEN: '',
          OPENAI_CODEX_ACCOUNT_ID: '',
          XAI_GROK_ACCESS_TOKEN: '',
          XAI_GROK_USER_ID: '',
          ...env
        }
      },
      (error, stdout, stderr) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

describe('record-usage-fixtures CLI', () => {
  it('dry-runs each family by default without credentials', async () => {
    for (const family of families) {
      const result = await runCli(['--family', family.family])

      expect(result.failed).toBe(false)
      expect(result.stdout).toContain(usageFamilies[family.family].caseId)
    }
  })

  it('refuses --live without approval, in CI, or without credentials', async () => {
    const unapproved = await runCli(['--family', 'claude', '--live', '--account', 'synthetic'])

    expect(unapproved.stderr).toContain('--live requires --owner-approved')

    const live = ['--family', 'codex', '--live', '--owner-approved', '--account', 'synthetic']

    const inCi = await runCli(live, {
      CI: 'false',
      OPENAI_CODEX_ACCESS_TOKEN: 'synthetic-not-a-token',
      OPENAI_CODEX_ACCOUNT_ID: 'synthetic'
    })

    expect(inCi.failed).toBe(true)
    expect(inCi.stderr).toContain(liveInCiMessage)

    const withoutAccount = await runCli(live, {
      OPENAI_CODEX_ACCESS_TOKEN: 'synthetic-not-a-token'
    })

    expect(withoutAccount.failed).toBe(true)
    expect(withoutAccount.stderr).toContain('OPENAI_CODEX_ACCOUNT_ID is required for --live')
  })
})
