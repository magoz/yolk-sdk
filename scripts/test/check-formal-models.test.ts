import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Layer, Option } from 'effect'
import { sha256 } from '../formal-model-manifest.ts'
import {
  Everystate,
  EverystateRunError,
  everystateChecker,
  EverystateChecker,
  everystateLauncher,
  ModelFiles,
  ModelsCheckAt,
  ModelsCheckCommand,
  ModelsCheckOutcome,
  modelsCheckSucceeded,
  parseModelsCheckArgs,
  renderModelsCheckOutcome,
  runModelsCheck,
  SyncOutcome,
  syncModel
} from '../check-formal-models.ts'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const tsxCli = join(repositoryRoot, 'node_modules/tsx/dist/cli.mjs')

const script = join(repositoryRoot, 'scripts/check-formal-models.ts')

describe('parseModelsCheckArgs', () => {
  it.effect('reads a check, a sync, and help, ignoring the `--` pnpm forwards', () =>
    Effect.gen(function* () {
      expect(yield* parseModelsCheckArgs([])).toEqual(ModelsCheckCommand.Check())
      expect(yield* parseModelsCheckArgs(['--', '--sync', 'a/formal/b.model.json'])).toEqual(
        ModelsCheckCommand.Sync({ manifest: 'a/formal/b.model.json' })
      )
      expect(yield* parseModelsCheckArgs(['-h'])).toEqual(ModelsCheckCommand.Help())
    })
  )

  it.effect('refuses an unknown option without repeating it', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseModelsCheckArgs(['--token=secret-value']))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).not.toContain('secret-value')
    })
  )
})

// ---------------------------------------------------------------------------------------------
// The check against an in-memory repository and a scripted everystate
// ---------------------------------------------------------------------------------------------

const manifestPath = 'packages/claims/formal/claim.model.json'

const manifestText = (coveredHash: string) =>
  JSON.stringify(
    {
      spec: 'Claim.tla',
      promise: 'A claim is taken at most once.',
      covers: [{ path: 'packages/claims/src/claims.ts', sha256: coveredHash }],
      checks: [{ config: 'Claim.cfg' }, { config: 'ClaimUnfenced.cfg', violates: 'AtMostOnce' }]
    },
    null,
    2
  )

const passing = '{"status":"ok","generated":20,"distinct":12,"queue":0,"depth":4}'

const violating = '{"status":"invariant","name":"AtMostOnce","distinct":7,"trace":[]}'

/**
 * An in-memory repository and a scripted everystate: one JSON line per configuration, and other
 * lines once a manifest was written (`resultsAfterWrite`).
 */
const fakes = (input: {
  readonly files: Readonly<Record<string, string>>
  readonly results: Readonly<Record<string, string | undefined>>
  readonly resultsAfterWrite?: Readonly<Record<string, string | undefined>>
}) => {
  const files = new Map(Object.entries(input.files))
  let written = false

  const layer = Layer.mergeAll(
    Layer.succeed(ModelFiles, {
      manifests: Effect.sync(() => [...files.keys()].filter(path => path.endsWith('.model.json'))),
      read: path => Effect.sync(() => files.get(path)),
      write: (path, text) =>
        Effect.sync(() => {
          written = true
          files.set(path, text)
        })
    }),
    Layer.succeed(Everystate, {
      run: ({ config }) => {
        const line = (written ? (input.resultsAfterWrite ?? input.results) : input.results)[config]

        return line === undefined
          ? Effect.fail(new EverystateRunError({ message: 'everystate printed no result' }))
          : Effect.succeed(line)
      }
    })
  )

  return { files, layer }
}

const repository = (coveredHash: string, coveredText = 'claim code') => ({
  [manifestPath]: manifestText(coveredHash),
  'packages/claims/formal/Claim.tla': '---- MODULE Claim ----\n====\n',
  'packages/claims/formal/Claim.cfg': 'SPECIFICATION Spec\n',
  'packages/claims/formal/ClaimUnfenced.cfg': 'SPECIFICATION Spec\n',
  'packages/claims/src/claims.ts': coveredText
})

const results = { 'Claim.cfg': passing, 'ClaimUnfenced.cfg': violating }

describe('runModelsCheck', () => {
  it.effect('passes when every configuration answers as declared and the code is unchanged', () =>
    Effect.gen(function* () {
      const { layer } = fakes({ files: repository(sha256('claim code')), results })
      const outcome = yield* runModelsCheck.pipe(Effect.provide(layer))

      expect(modelsCheckSucceeded(outcome)).toBe(true)
      expect(renderModelsCheckOutcome(outcome)).toContain(
        'ClaimUnfenced.cfg: violates AtMostOnce, as it must (7 states)'
      )
    })
  )

  it.effect('fails and names the covered file when the code changed since the model', () =>
    Effect.gen(function* () {
      const { layer } = fakes({ files: repository(sha256('claim code'), 'changed'), results })
      const outcome = yield* runModelsCheck.pipe(Effect.provide(layer))

      expect(modelsCheckSucceeded(outcome)).toBe(false)
      expect(renderModelsCheckOutcome(outcome)).toContain(
        'covered code changed: packages/claims/src/claims.ts'
      )
    })
  )

  it.effect('fails when the variant that must break passes, or the model does not run', () =>
    Effect.gen(function* () {
      const { layer } = fakes({
        files: repository(sha256('claim code')),
        results: { 'Claim.cfg': undefined, 'ClaimUnfenced.cfg': passing }
      })

      const outcome = yield* runModelsCheck.pipe(Effect.provide(layer))
      const rendered = renderModelsCheckOutcome(outcome)

      expect(modelsCheckSucceeded(outcome)).toBe(false)
      expect(rendered).toContain('Claim.cfg: everystate printed no result')
      expect(rendered).toContain('ClaimUnfenced.cfg: must violate AtMostOnce, got ok')
    })
  )

  it.effect('fails when a configuration named by the manifest is missing', () =>
    Effect.gen(function* () {
      const files = repository(sha256('claim code'))
      const { 'packages/claims/formal/ClaimUnfenced.cfg': _removed, ...rest } = files
      const { layer } = fakes({ files: rest, results })
      const outcome = yield* runModelsCheck.pipe(Effect.provide(layer))

      expect(modelsCheckSucceeded(outcome)).toBe(false)
      expect(renderModelsCheckOutcome(outcome)).toContain(
        '`ClaimUnfenced.cfg` is missing beside the manifest'
      )
    })
  )

  it.effect('fails when a manifest is not valid', () =>
    Effect.gen(function* () {
      const { layer } = fakes({ files: { [manifestPath]: '{"spec":"Claim.tla"}' }, results })
      const outcome = yield* runModelsCheck.pipe(Effect.provide(layer))

      expect(modelsCheckSucceeded(outcome)).toBe(false)
      expect(renderModelsCheckOutcome(outcome)).toContain('not a valid model manifest')
    })
  )

  it.effect('passes, and says so, when no model manifest exists', () =>
    Effect.gen(function* () {
      const { layer } = fakes({ files: {}, results })
      const outcome = yield* runModelsCheck.pipe(Effect.provide(layer))

      expect(outcome).toEqual(ModelsCheckOutcome.NoModels())
      expect(modelsCheckSucceeded(outcome)).toBe(true)
      expect(renderModelsCheckOutcome(outcome)).toContain('no model manifests found')
    })
  )
})

describe('syncModel', () => {
  it.effect('records the changed code once the model still holds, so the check passes', () =>
    Effect.gen(function* () {
      const { files, layer } = fakes({ files: repository(sha256('old'), 'claim code'), results })
      const outcome = yield* syncModel(manifestPath).pipe(Effect.provide(layer))

      expect(outcome).toEqual(
        SyncOutcome.Synced({ manifest: manifestPath, paths: ['packages/claims/src/claims.ts'] })
      )
      expect(files.get(manifestPath)).toBe(manifestText(sha256('claim code')))
      expect(modelsCheckSucceeded(yield* runModelsCheck.pipe(Effect.provide(layer)))).toBe(true)
    })
  )

  it.effect('reports a manifest that already matches its covered code', () =>
    Effect.gen(function* () {
      const { layer } = fakes({ files: repository(sha256('claim code')), results })
      const outcome = yield* syncModel(manifestPath).pipe(Effect.provide(layer))

      expect(outcome).toEqual(SyncOutcome.AlreadySynced({ manifest: manifestPath }))
    })
  )

  it.effect('refuses to record the code while a configuration does not answer as declared', () =>
    Effect.gen(function* () {
      const { files, layer } = fakes({
        files: repository(sha256('old')),
        results: { ...results, 'Claim.cfg': violating }
      })

      const outcome = yield* syncModel(manifestPath).pipe(Effect.provide(layer))

      expect(SyncOutcome.$is('Refused')(outcome)).toBe(true)
      expect(files.get(manifestPath)).toBe(manifestText(sha256('old')))
    })
  )

  it.effect('refuses, writing nothing, when a covered file is gone', () =>
    Effect.gen(function* () {
      const { 'packages/claims/src/claims.ts': _removed, ...rest } = repository(sha256('old'))
      const { files, layer } = fakes({ files: rest, results })
      const outcome = yield* syncModel(manifestPath).pipe(Effect.provide(layer))

      expect(SyncOutcome.$is('Refused')(outcome)).toBe(true)
      expect(files.get(manifestPath)).toBe(manifestText(sha256('old')))
    })
  )

  it.effect('refuses when the model no longer passes after the manifest is written', () =>
    Effect.gen(function* () {
      const { layer } = fakes({
        files: repository(sha256('old')),
        results,
        resultsAfterWrite: { ...results, 'Claim.cfg': violating }
      })

      const outcome = yield* syncModel(manifestPath).pipe(Effect.provide(layer))

      expect(SyncOutcome.$is('Refused')(outcome) ? outcome.reason : undefined).toBe(
        'the manifest was written but the model does not pass; inspect it by hand'
      )
    })
  )
})

// ---------------------------------------------------------------------------------------------
// The live layer: a temporary repository and the installed everystate
// ---------------------------------------------------------------------------------------------

const launcher = everystateLauncher(repositoryRoot)

// The installed native checker the script selects here, when this platform has one. Every test
// passes its own environment (empty, or naming its own checker), so a developer's
// `EVERYSTATE_BINARY` never applies.
const nativeChecker = Option.liftPredicate(
  everystateChecker(launcher, {}),
  EverystateChecker.$is('Native')
).pipe(Option.map(checker => checker.file))

// Executables the tests write live here, not in `tmpdir()`: a `noexec` `/tmp` would refuse to run
// them. `node_modules` is gitignored; each test removes its own folder.
const executableScratch = join(repositoryRoot, 'node_modules', '.cache', 'yolk-models-check')

const withExecutableScratch = <A, E>(test: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      await mkdir(executableScratch, { recursive: true })

      return mkdtemp(join(executableScratch, 'run-'))
    }),
    test,
    directory => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const writeTree = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.promise(async () => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
  })

const withRepository = <A, E>(
  files: Readonly<Record<string, string>>,
  test: (root: string) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'yolk-models-check-'))),
    root => writeTree(root, files).pipe(Effect.andThen(test(root))),
    root => Effect.promise(() => rm(root, { recursive: true, force: true }))
  )

// A counter that may reach 3: `Below` keeps it under 3, so the bound 2 passes and 3 breaks it.
const spec = [
  '---- MODULE Counter ----',
  'EXTENDS Naturals',
  'CONSTANT Bound',
  'VARIABLE n',
  'Init == n = 0',
  "Next == n < Bound /\\ n' = n + 1",
  'Spec == Init /\\ [][Next]_n',
  'Below == n < 3',
  '===='
].join('\n')

const config = (bound: number) =>
  `SPECIFICATION Spec\nCONSTANT Bound = ${bound}\nINVARIANT Below\nCHECK_DEADLOCK FALSE\n`

const counterManifestPath = 'packages/counter/formal/counter.model.json'

const counterManifest = (coveredHash: string) =>
  JSON.stringify(
    {
      spec: 'Counter.tla',
      promise: 'The counter stays below three.',
      covers: [{ path: 'packages/counter/src/counter.ts', sha256: coveredHash }],
      checks: [{ config: 'Counter.cfg' }, { config: 'CounterHigh.cfg', violates: 'Below' }]
    },
    null,
    2
  )

const counterCode = 'export const counter = 0\n'

const counterRepository = (coveredHash: string) => ({
  [counterManifestPath]: counterManifest(coveredHash),
  'packages/counter/formal/Counter.tla': spec,
  'packages/counter/formal/Counter.cfg': config(2),
  'packages/counter/formal/CounterHigh.cfg': config(3),
  'packages/counter/src/counter.ts': counterCode,
  // Installed packages, reference clones, hidden directories and build output are never searched.
  'node_modules/dep/formal/ignored.model.json': '{}',
  '.repos/effect/formal/ignored.model.json': '{}',
  'packages/counter/dist/formal/ignored.model.json': '{}'
})

describe('ModelsCheckAt', () => {
  it.effect('finds manifests outside skipped directories and reads a missing file as absent', () =>
    withRepository(counterRepository('x'), root =>
      Effect.gen(function* () {
        const files = yield* ModelFiles

        expect(yield* files.manifests).toEqual([counterManifestPath])
        expect(yield* files.read('packages/counter/gone.ts')).toBeUndefined()
      }).pipe(Effect.provide(ModelsCheckAt(root, launcher, { environment: {} })))
    )
  )

  it.effect('passes a repository without models', () =>
    withRepository({ 'packages/counter/src/counter.ts': counterCode }, root =>
      Effect.gen(function* () {
        expect(yield* runModelsCheck).toEqual(ModelsCheckOutcome.NoModels())
      }).pipe(Effect.provide(ModelsCheckAt(root, launcher, { environment: {} })))
    )
  )

  it.effect('runs the real checker: one configuration passes, the other breaks', () =>
    withRepository(counterRepository(sha256(counterCode)), root =>
      Effect.gen(function* () {
        const outcome = yield* runModelsCheck

        expect(renderModelsCheckOutcome(outcome)).toContain(
          'CounterHigh.cfg: violates Below, as it must'
        )
        expect(modelsCheckSucceeded(outcome)).toBe(true)
      }).pipe(Effect.provide(ModelsCheckAt(root, launcher, { environment: {} })))
    )
  )

  it.effect('syncs a changed covered file into the manifest on disk', () =>
    withRepository(counterRepository(sha256('before')), root =>
      Effect.gen(function* () {
        const outcome = yield* syncModel(counterManifestPath)

        expect(SyncOutcome.$is('Synced')(outcome)).toBe(true)
        expect(yield* Effect.promise(() => readFile(join(root, counterManifestPath), 'utf8'))).toBe(
          counterManifest(sha256(counterCode))
        )
      }).pipe(Effect.provide(ModelsCheckAt(root, launcher, { environment: {} })))
    )
  )
})

// ---------------------------------------------------------------------------------------------
// Which checker runs
// ---------------------------------------------------------------------------------------------

/** A copy of the everystate package layout: the launcher, and a native checker when given. */
const withEverystateCopy = <A, E>(
  native: { readonly from: string; readonly mode: number } | undefined,
  test: (copy: { readonly launcher: string; readonly native: string }) => Effect.Effect<A, E>
) =>
  withExecutableScratch(copy =>
    Effect.promise(async () => {
      const copiedLauncher = join(copy, 'bin', 'everystate.mjs')
      const nativeFile = join(copy, 'native', `${process.platform}-${process.arch}`, 'everystate')

      await mkdir(dirname(copiedLauncher), { recursive: true })
      await copyFile(launcher, copiedLauncher)

      if (native !== undefined) {
        await mkdir(dirname(nativeFile), { recursive: true })
        await copyFile(native.from, nativeFile)
        await chmod(nativeFile, native.mode)
      }

      return { launcher: copiedLauncher, native: nativeFile }
    }).pipe(Effect.flatMap(test))
  )

const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK)

    return true
  } catch {
    return false
  }
}

// Executable bits do not exist on Windows.
describe.skipIf(process.platform === 'win32')('everystateChecker', () => {
  it.effect('runs the launcher (the WebAssembly build) only when there is no native checker', () =>
    withEverystateCopy(undefined, copy =>
      Effect.sync(() => {
        expect(everystateChecker(copy.launcher, {})).toEqual(
          EverystateChecker.Wasm({ launcher: copy.launcher })
        )
      })
    )
  )

  it.effect('runs a native checker directly, restoring a missing executable bit first', () =>
    withEverystateCopy({ from: script, mode: 0o644 }, copy =>
      Effect.sync(() => {
        expect(everystateChecker(copy.launcher, {})).toEqual(
          EverystateChecker.Native({ file: copy.native })
        )
        expect(isExecutable(copy.native)).toBe(true)
      })
    )
  )

  it.effect('honours EVERYSTATE_BINARY, and refuses one that is not executable', () =>
    withEverystateCopy({ from: script, mode: 0o755 }, copy =>
      Effect.gen(function* () {
        expect(everystateChecker(copy.launcher, { EVERYSTATE_BINARY: copy.native })).toEqual(
          EverystateChecker.Native({ file: copy.native })
        )

        yield* Effect.promise(() => chmod(copy.native, 0o644))

        expect(
          EverystateChecker.$is('Unusable')(
            everystateChecker(copy.launcher, { EVERYSTATE_BINARY: copy.native })
          )
        ).toBe(true)
      })
    )
  )

  it.effect('resolves a relative EVERYSTATE_BINARY against the working directory', () =>
    withEverystateCopy({ from: script, mode: 0o755 }, copy =>
      Effect.sync(() => {
        expect(
          everystateChecker(copy.launcher, {
            EVERYSTATE_BINARY: relative(process.cwd(), copy.native)
          })
        ).toEqual(EverystateChecker.Native({ file: copy.native }))
      })
    )
  )

  it('refuses a bare EVERYSTATE_BINARY name instead of looking it up on PATH', () => {
    expect(everystateChecker(launcher, { EVERYSTATE_BINARY: 'everystate' })).toEqual(
      EverystateChecker.Unusable({
        message:
          'EVERYSTATE_BINARY (everystate) is a bare name, not a path; set it to the ' +
          "checker's absolute path, or a path relative to where the command runs (the repository root for pnpm)"
      })
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Stopping the checker: a model that never finishes must not leave a checker process behind
// ---------------------------------------------------------------------------------------------

type RunningProcess = { readonly pid: number; readonly args: string }

/**
 * Processes whose command line holds `marker` (`ps` works on Linux and macOS; `-ww` keeps long
 * command lines whole). A failing `ps` fails the test.
 */
const processesWith = (marker: string) =>
  Effect.promise(
    () =>
      new Promise<ReadonlyArray<RunningProcess>>((settle, refuse) => {
        execFile('ps', ['-ww', '-eo', 'pid=,args='], (error, stdout) => {
          if (error !== null) {
            refuse(error)

            return
          }

          settle(
            stdout
              .split('\n')
              .filter(line => line.includes(marker))
              .map(line => ({ pid: Number.parseInt(line.trim(), 10), args: line.trim() }))
          )
        })
      })
  )

/** Polls `processesWith(marker)` until `done` holds or `timeoutMs` passes; the last list. */
const pollProcesses = (
  marker: string,
  done: (running: ReadonlyArray<RunningProcess>) => boolean,
  timeoutMs: number
): Effect.Effect<ReadonlyArray<RunningProcess>> => {
  const deadline = Date.now() + timeoutMs

  const poll: Effect.Effect<ReadonlyArray<RunningProcess>> = processesWith(marker).pipe(
    Effect.flatMap(running =>
      done(running) || Date.now() > deadline
        ? Effect.succeed(running)
        : Effect.sleep('100 millis').pipe(Effect.andThen(Effect.suspend(() => poll)))
    )
  )

  return poll
}

/** Whether one of the processes runs `file` (the native checker itself, not only the launcher). */
const runs = (file: string) => (running: ReadonlyArray<RunningProcess>) =>
  running.some(entry => entry.args.includes(file))

const killAll = (running: ReadonlyArray<RunningProcess>) =>
  Effect.sync(() => {
    for (const { pid } of running) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

/**
 * A model whose passing configuration explores an unbounded state space, so everystate runs until
 * it is stopped. The spec name is unique, so its processes can be found by command line; any left
 * over are killed after the test.
 */
const withSpinningModel = <A, E>(test: (root: string, marker: string) => Effect.Effect<A, E>) => {
  const marker = `Spin${randomUUID().replaceAll('-', '')}`

  const files = {
    'packages/spin/formal/spin.model.json': JSON.stringify({
      spec: `${marker}.tla`,
      promise: 'Never finishes.',
      covers: [{ path: 'packages/spin/src/spin.ts', sha256: sha256(counterCode) }],
      checks: [{ config: `${marker}.cfg` }, { config: 'Breaks.cfg', violates: 'Tiny' }]
    }),
    [`packages/spin/formal/${marker}.tla`]: [
      `---- MODULE ${marker} ----`,
      'EXTENDS Naturals',
      'VARIABLES x, y',
      'Init == x = 0 /\\ y = 0',
      "Next == (x' = x + 1 /\\ y' = y) \\/ (y' = y + 1 /\\ x' = x)",
      'Spec == Init /\\ [][Next]_<<x, y>>',
      'Natural == x >= 0',
      'Tiny == x < 1',
      '===='
    ].join('\n'),
    [`packages/spin/formal/${marker}.cfg`]:
      'SPECIFICATION Spec\nINVARIANT Natural\nCHECK_DEADLOCK FALSE\n',
    'packages/spin/formal/Breaks.cfg': 'SPECIFICATION Spec\nINVARIANT Tiny\nCHECK_DEADLOCK FALSE\n',
    'packages/spin/src/spin.ts': counterCode
  }

  return withRepository(files, root =>
    test(root, marker).pipe(Effect.ensuring(processesWith(marker).pipe(Effect.flatMap(killAll))))
  )
}

// The WebAssembly build runs inside the launcher's process, so only a native checker
// (`nativeChecker`) can outlive what the script kills; there is nothing to test without one.
describe.skipIf(process.platform === 'win32' || Option.isNone(nativeChecker))(
  'stopping everystate',
  () => {
    const native = Option.getOrElse(nativeChecker, () => '')

    it.live('kills the checker when the check is interrupted', () =>
      withSpinningModel((root, marker) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            runModelsCheck.pipe(Effect.provide(ModelsCheckAt(root, launcher, { environment: {} })))
          )

          expect(runs(native)(yield* pollProcesses(marker, runs(native), 20_000))).toBe(true)

          yield* Fiber.interrupt(fiber)

          expect(yield* pollProcesses(marker, running => running.length === 0, 5_000)).toEqual([])
        })
      )
    )

    it.live('kills the checker when it runs past its time limit', () =>
      withSpinningModel((root, marker) =>
        Effect.gen(function* () {
          const outcome = yield* runModelsCheck.pipe(
            Effect.provide(ModelsCheckAt(root, launcher, { timeoutMs: 2_000, environment: {} }))
          )

          expect(modelsCheckSucceeded(outcome)).toBe(false)
          expect(renderModelsCheckOutcome(outcome)).toContain(
            `${marker}.cfg: everystate did not finish within 2 s`
          )
          expect(yield* pollProcesses(marker, running => running.length === 0, 5_000)).toEqual([])
        })
      )
    )

    it.live(
      'kills the checker on interruption when the native binary lacks the executable bit',
      () =>
        // The binary installed without its executable bit, as some installs leave it: the
        // launcher would repair it and start it behind `spawnSync`, out of reach of a kill.
        withEverystateCopy({ from: native, mode: 0o644 }, copy =>
          withSpinningModel((root, marker) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                runModelsCheck.pipe(
                  Effect.provide(ModelsCheckAt(root, copy.launcher, { environment: {} }))
                )
              )

              expect(
                runs(copy.native)(yield* pollProcesses(marker, runs(copy.native), 20_000))
              ).toBe(true)

              yield* Fiber.interrupt(fiber)

              expect(yield* pollProcesses(marker, running => running.length === 0, 5_000)).toEqual(
                []
              )
            })
          )
        )
    )
  }
)

// ---------------------------------------------------------------------------------------------
// Running the checker EVERYSTATE_BINARY names
// ---------------------------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('EVERYSTATE_BINARY', () => {
  // Each configuration runs in its model's folder, so a path relative to where the command runs
  // must still find the checker there.
  it.live.skipIf(Option.isNone(nativeChecker))(
    'runs a checker given by a path relative to the working directory',
    () =>
      withRepository(counterRepository(sha256(counterCode)), root =>
        Effect.gen(function* () {
          const native = Option.getOrElse(nativeChecker, () => '')
          const environment = { EVERYSTATE_BINARY: relative(process.cwd(), native) }

          const outcome = yield* runModelsCheck.pipe(
            Effect.provide(ModelsCheckAt(root, launcher, { environment }))
          )

          expect(renderModelsCheckOutcome(outcome)).toContain(
            'CounterHigh.cfg: violates Below, as it must'
          )
          expect(modelsCheckSucceeded(outcome)).toBe(true)
        })
      )
  )

  it.live('reports a checker that prints past the output buffer, and stops it', () =>
    withExecutableScratch(directory => {
      const marker = `Flood${randomUUID().replaceAll('-', '')}`
      const flood = join(directory, 'flood')

      return Effect.promise(async () => {
        // `exec`, so the kill reaches the printer itself; `marker` finds it by command line.
        await writeFile(flood, `#!/bin/sh\nexec yes ${marker}\n`)
        await chmod(flood, 0o755)
      }).pipe(
        Effect.andThen(
          withRepository(counterRepository(sha256(counterCode)), root =>
            Effect.gen(function* () {
              const outcome = yield* runModelsCheck.pipe(
                Effect.provide(
                  ModelsCheckAt(root, launcher, { environment: { EVERYSTATE_BINARY: flood } })
                )
              )

              const rendered = renderModelsCheckOutcome(outcome)

              expect(modelsCheckSucceeded(outcome)).toBe(false)
              expect(rendered).toContain('Counter.cfg: everystate printed more than 64 MiB')
              expect(rendered).toContain('CounterHigh.cfg: everystate printed more than 64 MiB')
              expect(yield* pollProcesses(marker, running => running.length === 0, 5_000)).toEqual(
                []
              )
            })
          )
        ),
        Effect.ensuring(processesWith(marker).pipe(Effect.flatMap(killAll)))
      )
    })
  )
})

// ---------------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------------

const runCli = (args: ReadonlyArray<string>) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    settle => {
      execFile(process.execPath, [tsxCli, script, ...args], (error, stdout, stderr) => {
        settle({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr })
      })
    }
  )

describe('pnpm models:check', () => {
  it('prints usage for --help and exits 0', async () => {
    const { code, stdout } = await runCli(['--help'])

    expect(code).toBe(0)
    expect(stdout).toContain('Usage: pnpm models:check')
  })

  it('refuses an unknown option with usage, without repeating it, and exits 1', async () => {
    const { code, stdout, stderr } = await runCli(['--token=secret-value'])

    expect(code).toBe(1)
    expect(stderr).toContain('Unknown option')
    expect(`${stdout}${stderr}`).not.toContain('secret-value')
  })
})
