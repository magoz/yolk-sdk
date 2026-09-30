import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  openCodeGoConformanceCases,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceFixtures,
  openCodeGoResponsesPlainTextFixture,
  openCodeGoUsageSnapshotFixture
} from '../../packages/agent/src/providers/opencode/conformance/index.ts'
import type { WireChunk, WireFixture } from '../../packages/conformance/src/fixture.ts'
import { conformanceReportFailed } from '../../packages/conformance/src/runner.ts'
import type { FixtureWriter } from '../fixture-probe-internal.ts'
import {
  casesWithoutSingleFixture,
  defaultProbeOptions,
  dryRunReport,
  liveAccountRequiredMessage,
  liveInCiMessage,
  modelsRequiredMessage,
  openCodeApiKeyEnv,
  openCodeFixtureModules,
  openCodeRedaction,
  ownerApprovalRequiredMessage,
  parseProbeArgs,
  planOpenCodeProbe,
  probeModels,
  renderFixtureModule,
  verifyOpenCodeFixtures,
  writeVerifiedFixtures,
  type RecordedOpenCodeFixture
} from '../record-opencode-fixtures.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const probeScript = join(repoRoot, 'scripts/record-opencode-fixtures.ts')

const liveArgs = [
  '--live',
  '--owner-approved',
  '--account',
  'synthetic',
  '--chat-model',
  'go-chat',
  '--messages-model=go-messages',
  '--responses-model',
  'go-responses'
]

describe('record-opencode-fixtures arguments', () => {
  it('defaults to a dry run with the synthetic default models', () => {
    expect(parseProbeArgs([])).toEqual(defaultProbeOptions)
    expect(parseProbeArgs(['--help']).help).toBe(true)
    expect(probeModels(defaultProbeOptions)).toEqual(openCodeGoConformanceDefaultModels)
    expect(openCodeApiKeyEnv).toBe('OPENCODE_API_KEY')
    expect(() => parseProbeArgs(['--nope'])).toThrow('Unknown argument: --nope')
    expect(() => parseProbeArgs(['--max-output-tokens', '0'])).toThrow('positive integer')
    expect(parseProbeArgs(['--max-output-tokens=64']).maxOutputTokens).toBe(64)
  })

  it('requires owner approval, an account label, and every protocol model with --live', () => {
    expect(() => parseProbeArgs(['--live'])).toThrow(ownerApprovalRequiredMessage)
    expect(() => parseProbeArgs(['--live', '--owner-approved'])).toThrow(liveAccountRequiredMessage)
    expect(() =>
      parseProbeArgs(['--live', '--owner-approved', '--account', 'synthetic', '--chat-model', 'x'])
    ).toThrow(modelsRequiredMessage)

    const options = parseProbeArgs(liveArgs)

    expect(options).toMatchObject({ live: true, ownerApproved: true, account: 'synthetic' })
    expect(probeModels(options)).toEqual({
      chat: 'go-chat',
      messages: 'go-messages',
      responses: 'go-responses'
    })
  })

  it('refuses --live whenever CI is set to a non-empty value', () => {
    for (const CI of ['true', '1', '0', 'false']) {
      expect(() => parseProbeArgs(liveArgs, { CI })).toThrow(liveInCiMessage)
    }

    expect(parseProbeArgs(liveArgs, { CI: '' }).live).toBe(true)
  })
})

describe('record-opencode-fixtures plan', () => {
  it('maps every Go case to its existing fixture file and export', () => {
    const plan = planOpenCodeProbe(defaultProbeOptions)

    expect(plan.map(entry => entry.caseId)).toEqual(
      openCodeGoConformanceCases.map(testCase => testCase.id)
    )
    expect(plan.map(entry => entry.fixtureModule.exportName)).toEqual([
      'openCodeGoChatPlainTextFixture',
      'openCodeGoMessagesPlainTextFixture',
      'openCodeGoResponsesPlainTextFixture',
      'openCodeGoResponsesCommentaryReplayFixture',
      'openCodeGoUsageSnapshotFixture'
    ])
    expect(plan.map(entry => entry.model)).toEqual([
      'synthetic-go-chat',
      'synthetic-go-messages',
      'synthetic-go-responses',
      'synthetic-go-responses',
      undefined
    ])
    // The fixture modules' endpoints match the committed fixtures.
    expect(openCodeFixtureModules.map(entry => entry.endpoint)).toEqual(
      openCodeGoConformanceFixtures.map(fixture => fixture.endpoint)
    )
  })

  it('dry-runs every case id with its endpoints and the approval note', () => {
    const report = dryRunReport(defaultProbeOptions)

    expect(report).toContain('DRY RUN: no network request was made and no credential was read')
    expect(report).toContain('OPENCODE_API_KEY')
    expect(report).toContain("need the repository owner's explicit approval")

    for (const testCase of openCodeGoConformanceCases) expect(report).toContain(testCase.id)
  })

  it('renders a fixture module typed with the conformance fixture type', () => {
    const [entry] = openCodeFixtureModules

    const rendered = renderFixtureModule(entry ?? expect.fail('no module'), {
      ...openCodeGoResponsesPlainTextFixture,
      evidence: 'verified'
    })

    expect(rendered).toContain("import type { WireFixture } from '@yolk-sdk/conformance/fixture'")
    expect(rendered).toContain('export const openCodeGoChatPlainTextFixture: WireFixture = {')
    expect(rendered).toContain('pnpm conformance:opencode --live --owner-approved')
  })

  it('redacts encrypted and account fields and leaves the committed fixtures clean', () => {
    expect(openCodeRedaction.fields).toEqual(
      expect.arrayContaining(['encrypted_content', 'signature', 'user', 'email', 'account_id'])
    )
  })
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

// Fake live recordings: each planned case paired with a fixture, no network involved.
const recordedFrom = (
  fixtures: ReadonlyArray<WireFixture>
): ReadonlyArray<RecordedOpenCodeFixture> =>
  planOpenCodeProbe(defaultProbeOptions).flatMap(entry =>
    fixtures.flatMap(fixture => (fixture.caseId === entry.caseId ? [{ entry, fixture }] : []))
  )

const replacing = (id: string, fixture: WireFixture): ReadonlyArray<WireFixture> =>
  openCodeGoConformanceFixtures.map(current => (current.id === id ? fixture : current))

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : '')

describe('record-opencode-fixtures replay verification and write gate', () => {
  it('passes every case against the committed fixtures', async () => {
    const report = await Effect.runPromise(
      verifyOpenCodeFixtures(openCodeGoConformanceFixtures, defaultProbeOptions)
    )

    expect(conformanceReportFailed(report)).toBe(false)
    expect(casesWithoutSingleFixture(openCodeGoConformanceFixtures)).toEqual([])
  })

  it('writes every fixture module, then formats them, only after replay verification passes', async () => {
    const { calls, writer } = recordingWriter()

    const result = await Effect.runPromise(
      writeVerifiedFixtures(
        recordedFrom(openCodeGoConformanceFixtures),
        defaultProbeOptions,
        writer
      )
    )

    expect(result.files.map(file => basename(file))).toEqual(
      openCodeFixtureModules.map(entry => entry.fileName)
    )
    expect(result.files.every(file => file.includes('providers/opencode/conformance'))).toBe(true)
    expect(calls).toEqual([
      ...result.files.map(file => ({ kind: 'write', paths: [file] })),
      { kind: 'format', paths: result.files }
    ])
  })

  it('writes nothing when a recording fails replay verification', async () => {
    const { calls, writer } = recordingWriter()

    const tampered: WireFixture = {
      ...openCodeGoUsageSnapshotFixture,
      exchanges: [
        {
          request: openCodeGoUsageSnapshotFixture.exchanges[0].request,
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"usage":{}}'
          }
        }
      ]
    }

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(replacing(openCodeGoUsageSnapshotFixture.id, tampered)),
        defaultProbeOptions,
        writer
      )
    )

    expect(failureText(exit)).toContain('no fixture was written')
    expect(calls).toEqual([])
  })

  it('writes nothing when an account field survives in a usage body', async () => {
    const { calls, writer } = recordingWriter()

    const withAccount: WireFixture = {
      ...openCodeGoUsageSnapshotFixture,
      exchanges: [
        {
          request: openCodeGoUsageSnapshotFixture.exchanges[0].request,
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"workspaceID":42,"usage":{"rolling":{"percent":1}}}'
          }
        }
      ]
    }

    // Replay alone would pass: the parser never reads `workspaceID`.
    const report = await Effect.runPromise(
      verifyOpenCodeFixtures(
        replacing(openCodeGoUsageSnapshotFixture.id, withAccount),
        defaultProbeOptions
      )
    )

    expect(conformanceReportFailed(report)).toBe(false)

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(replacing(openCodeGoUsageSnapshotFixture.id, withAccount)),
        defaultProbeOptions,
        writer
      )
    )

    expect(failureText(exit)).toContain('could not redact workspaceID')
    expect(calls).toEqual([])
  })

  const withChunks = (extra: ReadonlyArray<WireChunk>, position: 'before' | 'after') => {
    const response = openCodeGoResponsesPlainTextFixture.exchanges[0].response

    return {
      ...openCodeGoResponsesPlainTextFixture,
      exchanges: [
        {
          request: openCodeGoResponsesPlainTextFixture.exchanges[0].request,
          response:
            'chunks' in response && response.chunks !== undefined
              ? {
                  ...response,
                  chunks:
                    position === 'before'
                      ? [...extra, ...response.chunks]
                      : [...response.chunks, ...extra]
                }
              : expect.fail('not a stream')
        }
      ]
    } satisfies WireFixture
  }

  const refusedWrite = async (fixture: WireFixture) => {
    const { calls, writer } = recordingWriter()

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(replacing(openCodeGoResponsesPlainTextFixture.id, fixture)),
        defaultProbeOptions,
        writer
      )
    )

    expect(calls).toEqual([])

    return failureText(exit)
  }

  it('writes nothing when a stream carries an SSE line the parsers ignore', async () => {
    for (const line of [
      ': keep-alive\n\n',
      '"synthetic-private-note"\n\n',
      '{"note":"synthetic"}\n\n'
    ]) {
      expect(await refusedWrite(withChunks([line], 'before')), line).toContain(
        'SSE line(s) the stream parsers ignore'
      )
    }
  })

  it('writes nothing for a bare [DONE] line that is not a data: payload', async () => {
    expect(await refusedWrite(withChunks(['[DONE]\n\n'], 'after'))).toContain(
      'SSE line(s) the stream parsers ignore'
    )
  })

  it('writes nothing when a base64 chunk does not decode', async () => {
    expect(await refusedWrite(withChunks([{ base64: '@@not-base64@@' }], 'after'))).toContain(
      'undecodable base64'
    )
  })

  it('writes nothing when a case has no recording', async () => {
    const { calls, writer } = recordingWriter()

    const exit = await Effect.runPromiseExit(
      writeVerifiedFixtures(
        recordedFrom(
          openCodeGoConformanceFixtures.filter(
            fixture => fixture.id !== openCodeGoUsageSnapshotFixture.id
          )
        ),
        defaultProbeOptions,
        writer
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })
})

const runCli = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolvePromise => {
    execFile(
      process.execPath,
      [tsxCli, probeScript, ...args],
      { cwd: repoRoot, env: { ...process.env, CI: '', OPENCODE_API_KEY: '', ...env } },
      (error, stdout, stderr) => {
        resolvePromise({ failed: error !== null, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

describe('record-opencode-fixtures CLI', () => {
  it('dry-runs by default without needing a key, also in CI', async () => {
    const envs: ReadonlyArray<Record<string, string>> = [{}, { CI: 'true' }]

    for (const env of envs) {
      const result = await runCli([], env)

      expect(result.failed).toBe(false)
      expect(result.stdout).toContain('DRY RUN: no network request was made')
    }
  })

  it('refuses --live without approval, in CI, or without the key, before any network call', async () => {
    const unapproved = await runCli(['--live', '--account', 'synthetic'])

    expect(unapproved.failed).toBe(true)
    expect(unapproved.stderr).toContain('--live requires --owner-approved')

    const inCi = await runCli(liveArgs, { CI: '0', OPENCODE_API_KEY: 'synthetic-not-a-key' })

    expect(inCi.failed).toBe(true)
    expect(inCi.stderr).toContain(liveInCiMessage)

    const keyless = await runCli(liveArgs)

    expect(keyless.failed).toBe(true)
    expect(keyless.stderr).toContain('OPENCODE_API_KEY is required for --live')
  })
})
