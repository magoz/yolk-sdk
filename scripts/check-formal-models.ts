/**
 * Formal model check (`pnpm models:check`, part of `pnpm check`; `patterns/FORMAL_VERIFICATION.md`).
 *
 * Finds every model manifest (`**` `/formal/*.model.json`, outside hidden directories, installed
 * packages and build output), runs each configuration it lists with everystate, and fails when:
 *
 * - a configuration does not pass, or does not break the invariant its manifest names;
 * - a manifest is invalid, names a file missing beside it, or lacks a configuration that must pass
 *   or one that must fail;
 * - a file the model covers changed (its SHA-256 differs from the manifest's) or is gone.
 *
 * No manifest at all passes: committed models are optional (`docs/adr/0015-formal-verification.md`).
 *
 * `--sync <manifest>` records the covered files' current hashes in that manifest, only while every
 * configuration still answers as declared; run it after re-checking the model against the changed
 * code. It writes only that manifest.
 */
import { execFile } from 'node:child_process'
import { glob, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Console, Context, Data, Effect, Layer, Option, Result, Schema } from 'effect'
import {
  CheckVerdict,
  checkVerdict,
  CoverageDrift,
  coverageDrift,
  EverystateResultJson,
  manifestProblems,
  ModelManifestJson,
  syncedManifestText,
  type ModelCheck,
  type ModelManifest
} from './formal-model-manifest.ts'

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export type ModelsCheckCommand =
  | { readonly _tag: 'Help' }
  | { readonly _tag: 'Check' }
  /** Records the covered files' current hashes in one manifest, once its checks still hold. */
  | { readonly _tag: 'Sync'; readonly manifest: string }

export const ModelsCheckCommand = Data.taggedEnum<ModelsCheckCommand>()

export class ModelsCheckUsageError extends Schema.TaggedError<ModelsCheckUsageError>()(
  'ModelsCheckUsageError',
  { message: Schema.String }
) {}

export const modelsCheckUsage = [
  'Usage: pnpm models:check [--sync <path to *.model.json>]',
  '',
  'Runs every formal model (`**/formal/*.model.json`) with everystate and fails when a',
  'configuration does not pass or break as its manifest declares, when a manifest lacks a',
  'configuration that must pass or one that must fail, or when a file the model covers changed',
  'since the model was last confirmed against it. After re-checking the model against the',
  'changed code, --sync records the files as they are now. See patterns/FORMAL_VERIFICATION.md.'
].join('\n')

const ParsedValues = Schema.Struct({
  help: Schema.optional(Schema.Boolean),
  sync: Schema.optional(Schema.String)
})

// The part of a `node:util` `parseArgs` error that is safe to read: its Node error code.
const decodeParseArgsFailure = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

// Node's own messages quote the argument; a mistyped command can carry a secret, so never echo it.
const parseArgsErrorMessage = (error: unknown) => {
  switch (Option.getOrUndefined(decodeParseArgsFailure(error))?.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return 'Unknown option'
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return 'Unexpected argument (options take --name value)'
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return 'An option is missing its value or does not take one'
    default:
      return 'Invalid arguments'
  }
}

/** Parses CLI arguments (after `node <script>`): `--help`, or `--sync <manifest>`. */
export const parseModelsCheckArgs = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // pnpm forwards a literal `--` when invoked as `pnpm models:check -- ...`.
    const args = argv[0] === '--' ? argv.slice(1) : [...argv]

    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args,
          strict: true,
          allowPositionals: false,
          options: { help: { type: 'boolean', short: 'h' }, sync: { type: 'string' } }
        }).values,
      catch: error =>
        new ModelsCheckUsageError({
          message: `${parseArgsErrorMessage(error)}\n\n${modelsCheckUsage}`
        })
    })

    const values = yield* Schema.decodeUnknownEffect(ParsedValues)(parsed).pipe(
      Effect.mapError(() => new ModelsCheckUsageError({ message: modelsCheckUsage }))
    )

    if (values.help === true) return ModelsCheckCommand.Help() satisfies ModelsCheckCommand

    return values.sync === undefined
      ? (ModelsCheckCommand.Check() satisfies ModelsCheckCommand)
      : (ModelsCheckCommand.Sync({ manifest: values.sync }) satisfies ModelsCheckCommand)
  }).pipe(Effect.withSpan('models-check.parse-args'))

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

export class ModelsCheckReadError extends Schema.TaggedError<ModelsCheckReadError>()(
  'ModelsCheckReadError',
  { message: Schema.String }
) {}

export class ModelsCheckWriteError extends Schema.TaggedError<ModelsCheckWriteError>()(
  'ModelsCheckWriteError',
  { message: Schema.String }
) {}

export class EverystateRunError extends Schema.TaggedError<EverystateRunError>()(
  'EverystateRunError',
  { message: Schema.String }
) {}

/** The repository's files, by repository-relative `/`-separated path. */
export class ModelFiles extends Context.Service<
  ModelFiles,
  {
    /** Every model manifest (`**` `/formal/*.model.json`). */
    readonly manifests: Effect.Effect<ReadonlyArray<string>, ModelsCheckReadError>
    /** A file's text, or undefined when it does not exist. */
    readonly read: (path: string) => Effect.Effect<string | undefined, ModelsCheckReadError>
    readonly write: (path: string, text: string) => Effect.Effect<void, ModelsCheckWriteError>
  }
>()('@yolk/scripts/ModelFiles') {}

/** The everystate model checker. */
export class Everystate extends Context.Service<
  Everystate,
  {
    /** Runs `everystate -json -config <config> <spec>` in `directory`; returns its JSON line. */
    readonly run: (input: {
      readonly directory: string
      readonly spec: string
      readonly config: string
    }) => Effect.Effect<string, EverystateRunError>
  }
>()('@yolk/scripts/Everystate') {}

// ---------------------------------------------------------------------------------------------
// Check and sync
// ---------------------------------------------------------------------------------------------

export type ModelReport = Data.TaggedEnum<{
  /** The model could not be checked at all (an invalid manifest, a missing file). */
  Unchecked: { readonly manifest: string; readonly problems: ReadonlyArray<string> }
  Checked: {
    readonly manifest: string
    readonly verdicts: ReadonlyArray<CheckVerdict>
    readonly drift: ReadonlyArray<CoverageDrift>
  }
}>

export const ModelReport = Data.taggedEnum<ModelReport>()

const allMatched = (verdicts: ReadonlyArray<CheckVerdict>) =>
  verdicts.every(verdict => CheckVerdict.$is('Matched')(verdict))

export const modelReportPassed = (report: ModelReport) =>
  ModelReport.$match(report, {
    Unchecked: () => false,
    Checked: ({ verdicts, drift }) => drift.length === 0 && allMatched(verdicts)
  })

const runCheck = (directory: string, spec: string, check: ModelCheck) =>
  Effect.gen(function* () {
    const everystate = yield* Everystate

    return yield* everystate.run({ directory, spec, config: check.config }).pipe(
      Effect.map(line =>
        Option.match(Schema.decodeUnknownOption(EverystateResultJson)(line), {
          onNone: () =>
            CheckVerdict.Unexpected({
              config: check.config,
              message: 'everystate printed no readable result'
            }),
          onSome: result => checkVerdict(check, result)
        })
      ),
      Effect.catchTag('EverystateRunError', error =>
        Effect.succeed(CheckVerdict.Unexpected({ config: check.config, message: error.message }))
      )
    )
  })

const missingFiles = (directory: string, manifest: ModelManifest) =>
  Effect.gen(function* () {
    const files = yield* ModelFiles
    const names = [manifest.spec, ...manifest.checks.map(check => check.config)]

    const missing = yield* Effect.filter(names, name =>
      files.read(posix.join(directory, name)).pipe(Effect.map(text => text === undefined))
    )

    return missing.map(name => `\`${name}\` is missing beside the manifest`)
  })

const currentCovers = (manifest: ModelManifest) =>
  Effect.gen(function* () {
    const files = yield* ModelFiles

    return yield* Effect.forEach(manifest.covers, covered =>
      files.read(covered.path).pipe(Effect.map(text => ({ path: covered.path, text })))
    )
  })

/** A manifest's text decoded and checked for what it must hold, or why it cannot be checked. */
const loadManifest = (manifestPath: string, text: string | undefined) =>
  Effect.gen(function* () {
    if (text === undefined) return Result.fail(['the manifest does not exist'])

    const decoded = Schema.decodeUnknownOption(ModelManifestJson)(text)

    if (Option.isNone(decoded)) {
      return Result.fail(['not a valid model manifest (spec, promise, covers, checks)'])
    }

    const problems = [
      ...manifestProblems(decoded.value),
      ...(yield* missingFiles(posix.dirname(manifestPath), decoded.value))
    ]

    return problems.length > 0 ? Result.fail(problems) : Result.succeed(decoded.value)
  })

/** Checks one model: its manifest, every configuration, and the code it covers. */
export const checkModel = (manifestPath: string) =>
  Effect.gen(function* () {
    const files = yield* ModelFiles
    const loaded = yield* loadManifest(manifestPath, yield* files.read(manifestPath))

    if (Result.isFailure(loaded)) {
      return ModelReport.Unchecked({ manifest: manifestPath, problems: loaded.failure })
    }

    const manifest = loaded.success

    const verdicts = yield* Effect.forEach(
      manifest.checks,
      check => runCheck(posix.dirname(manifestPath), manifest.spec, check),
      { concurrency: 4 }
    )

    return ModelReport.Checked({
      manifest: manifestPath,
      verdicts,
      drift: coverageDrift(manifest, yield* currentCovers(manifest))
    })
  }).pipe(Effect.withSpan('models-check.model'))

export type ModelsCheckOutcome = Data.TaggedEnum<{
  /** No manifest was found: no protocol has a committed model yet. Passes. */
  NoModels: Record<never, never>
  Checked: { readonly reports: ReadonlyArray<ModelReport> }
}>

export const ModelsCheckOutcome = Data.taggedEnum<ModelsCheckOutcome>()

export const runModelsCheck = Effect.gen(function* () {
  const files = yield* ModelFiles
  const manifests = yield* files.manifests

  if (manifests.length === 0) return ModelsCheckOutcome.NoModels()

  const reports = yield* Effect.forEach(manifests.toSorted(), checkModel)

  return ModelsCheckOutcome.Checked({ reports })
}).pipe(Effect.withSpan('models-check.run'))

export const modelsCheckSucceeded = (outcome: ModelsCheckOutcome) =>
  ModelsCheckOutcome.$match(outcome, {
    NoModels: () => true,
    Checked: ({ reports }) => reports.every(modelReportPassed)
  })

export type SyncOutcome = Data.TaggedEnum<{
  Synced: { readonly manifest: string; readonly paths: ReadonlyArray<string> }
  AlreadySynced: { readonly manifest: string }
  /** The model does not hold as declared, so the covered code is not recorded as confirmed. */
  Refused: { readonly report: ModelReport; readonly reason: string }
}>

export const SyncOutcome = Data.taggedEnum<SyncOutcome>()

/**
 * Records the covered files' current hashes in one manifest, only while every configuration still
 * answers as declared. Run it after re-checking the model against the changed code. The new text
 * is verified before it is written, and the model must pass after.
 */
export const syncModel = (manifestPath: string) =>
  Effect.gen(function* () {
    const files = yield* ModelFiles
    const report = yield* checkModel(manifestPath)

    if (ModelReport.$is('Unchecked')(report) || !allMatched(report.verdicts)) {
      return SyncOutcome.Refused({
        report,
        reason: 'the model does not hold as its manifest declares; fix the model first'
      })
    }

    if (report.drift.length === 0) {
      return SyncOutcome.AlreadySynced({ manifest: manifestPath })
    }

    const text = yield* files.read(manifestPath)
    const synced = text === undefined ? undefined : syncedManifestText(text, report.drift)

    const syncedManifest =
      synced === undefined ? Option.none() : Schema.decodeUnknownOption(ModelManifestJson)(synced)

    const stillDrifts =
      synced === undefined ||
      Option.isNone(syncedManifest) ||
      coverageDrift(syncedManifest.value, yield* currentCovers(syncedManifest.value)).length > 0

    if (synced === undefined || stillDrifts) {
      return SyncOutcome.Refused({
        report,
        reason:
          'could not record the hashes in place: a covered file is missing (edit `covers` to ' +
          'name where its code went) or an entry is not written as "path", then "sha256"'
      })
    }

    yield* files.write(manifestPath, synced)

    const after = yield* checkModel(manifestPath)

    if (!modelReportPassed(after)) {
      return SyncOutcome.Refused({
        report: after,
        reason: 'the manifest was written but the model does not pass; inspect it by hand'
      })
    }

    return SyncOutcome.Synced({
      manifest: manifestPath,
      paths: report.drift.map(entry => entry.path)
    })
  }).pipe(Effect.withSpan('models-check.sync'))

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const renderDrift = (manifest: string, drift: ReadonlyArray<CoverageDrift>) =>
  drift.length === 0
    ? []
    : [
        ...drift.map(entry =>
          CoverageDrift.$match(entry, {
            Changed: ({ path }) => `      covered code changed: ${path}`,
            Missing: ({ path }) => `      covered code is missing: ${path}`
          })
        ),
        '      Re-check the model against that code (patterns/FORMAL_VERIFICATION.md, "Keeping',
        `      models true to the code"), then run \`pnpm models:check --sync ${manifest}\`.`
      ]

const renderVerdict = (verdict: CheckVerdict) =>
  CheckVerdict.$match(verdict, {
    Matched: ({ config, violates, states }) =>
      `      ${config}: ${violates === undefined ? 'passes' : `violates ${violates}, as it must`}${
        states === undefined ? '' : ` (${states} states)`
      }`,
    Unexpected: ({ config, message }) => `      ${config}: ${message}`
  })

export const renderModelReport = (report: ModelReport) =>
  [
    `  ${modelReportPassed(report) ? 'ok  ' : 'FAIL'} ${report.manifest}`,
    ...ModelReport.$match(report, {
      Unchecked: ({ problems }) => problems.map(problem => `      ${problem}`),
      Checked: ({ manifest, verdicts, drift }) => [
        ...verdicts.map(renderVerdict),
        ...renderDrift(manifest, drift)
      ]
    })
  ].join('\n')

export const renderModelsCheckOutcome = (outcome: ModelsCheckOutcome) =>
  ModelsCheckOutcome.$match(outcome, {
    NoModels: () =>
      'models:check: no model manifests found (`**/formal/*.model.json`); nothing to check.',
    Checked: ({ reports }) =>
      [`models:check: ${reports.length} model(s)`, ...reports.map(renderModelReport)].join('\n')
  })

export const renderSyncOutcome = (outcome: SyncOutcome) =>
  SyncOutcome.$match(outcome, {
    Synced: ({ manifest, paths }) =>
      `models:check: recorded ${paths.join(', ')} as confirmed in ${manifest}.`,
    AlreadySynced: ({ manifest }) => `models:check: ${manifest} already matches its covered code.`,
    Refused: ({ report, reason }) =>
      [`models:check: not synced: ${reason}.`, renderModelReport(report)].join('\n')
  })

// ---------------------------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------------------------

// Directories never searched for manifests: hidden ones (`.git`, `.repos`, `.next`, `.turbo`,
// `.source`, `.alchemy`, `.workflow-*`, ...), installed packages, and build or test output.
const skippedDirectoryNames = new Set([
  'node_modules',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report'
])

const isSkippedDirectory = (path: string) => {
  const name = basename(path)

  return name.startsWith('.') || skippedDirectoryNames.has(name)
}

const toRepositoryPath = (path: string) => path.split(/[\\/]/).join('/')

/** A read of a file that does not exist: reported as no file, not as a failure. */
class MissingFileError extends Data.TaggedError('MissingFileError') {}

// The part of a failed read that says the file does not exist.
const decodeMissingFile = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.Literal('ENOENT') })
)

const modelFilesAt = (root: string) => {
  const absolute = (path: string) => join(root, ...path.split('/'))

  return ModelFiles.of({
    manifests: Effect.tryPromise({
      try: () =>
        Array.fromAsync(glob('**/formal/*.model.json', { cwd: root, exclude: isSkippedDirectory })),
      catch: () => new ModelsCheckReadError({ message: 'could not search for model manifests' })
    }).pipe(Effect.map(paths => paths.map(toRepositoryPath))),
    read: path =>
      Effect.tryPromise({
        try: () => readFile(absolute(path), 'utf8'),
        catch: error =>
          Option.isSome(decodeMissingFile(error))
            ? new MissingFileError()
            : new ModelsCheckReadError({ message: `could not read ${path}` })
      }).pipe(Effect.catchTag('MissingFileError', () => Effect.undefined)),
    write: (path, text) =>
      Effect.tryPromise({
        try: () => writeFile(absolute(path), text, 'utf8'),
        catch: () => new ModelsCheckWriteError({ message: `could not write ${path}` })
      })
  })
}

// A model that runs this long is too large for the check; keep checked configurations small.
const everystateTimeoutMs = 10 * 60_000

const runEverystate = (
  root: string,
  launcher: string,
  input: { readonly directory: string; readonly spec: string; readonly config: string }
) =>
  Effect.callback<string, EverystateRunError>(resume => {
    const child = execFile(
      process.execPath,
      [launcher, '-json', '-config', input.config, input.spec],
      {
        cwd: join(root, ...input.directory.split('/')),
        maxBuffer: 1 << 26,
        timeout: everystateTimeoutMs
      },
      (error, stdout) => {
        const line = stdout
          .split('\n')
          .map(part => part.trim())
          .findLast(part => part !== '')

        // Its own exit codes (12 for a violation) also arrive as `error`; only no output fails.
        const reason = error === null ? 'exited' : String(error.signal ?? error.code ?? 'failed')

        resume(
          line === undefined
            ? Effect.fail(
                new EverystateRunError({ message: `everystate printed no result (${reason})` })
              )
            : Effect.succeed(line)
        )
      }
    )

    return Effect.sync(() => {
      child.kill()
    })
  })

/**
 * The working tree under `root`, checked with the everystate `launcher`
 * (`node_modules/everystate/bin/everystate.mjs`: it runs the prebuilt native binary for this
 * platform, or its WebAssembly build).
 */
export const ModelsCheckAt = (root: string, launcher: string) =>
  Layer.mergeAll(
    Layer.succeed(ModelFiles, modelFilesAt(root)),
    Layer.succeed(Everystate, Everystate.of({ run: input => runEverystate(root, launcher, input) }))
  )

// This file is `scripts/check-formal-models.ts`: the repository root is one level up, wherever
// the command runs from. The package `exports` map hides the launcher from module resolution, so
// it runs by path.
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const everystateLauncher = (root: string) =>
  join(root, 'node_modules', 'everystate', 'bin', 'everystate.mjs')

export const ModelsCheckLive = ModelsCheckAt(repositoryRoot, everystateLauncher(repositoryRoot))

// ---------------------------------------------------------------------------------------------
// CLI boundary
// ---------------------------------------------------------------------------------------------

const exitFailed = Effect.sync(() => {
  process.exitCode = 1
})

const exitWithError = (message: string) => Console.error(message).pipe(Effect.andThen(exitFailed))

const check = runModelsCheck.pipe(
  Effect.flatMap(outcome =>
    modelsCheckSucceeded(outcome)
      ? Console.log(renderModelsCheckOutcome(outcome))
      : Console.error(renderModelsCheckOutcome(outcome)).pipe(Effect.andThen(exitFailed))
  )
)

const sync = (manifest: string) =>
  syncModel(manifest).pipe(
    Effect.flatMap(outcome =>
      SyncOutcome.$is('Refused')(outcome)
        ? Console.error(renderSyncOutcome(outcome)).pipe(Effect.andThen(exitFailed))
        : Console.log(renderSyncOutcome(outcome))
    )
  )

/** The whole CLI for `argv` (after `node <script>`), every typed failure reported and handled. */
export const modelsCheckCli = (argv: ReadonlyArray<string>): Effect.Effect<void> =>
  parseModelsCheckArgs(argv).pipe(
    Effect.flatMap(command =>
      ModelsCheckCommand.$match(command, {
        Help: () => Console.log(modelsCheckUsage),
        Check: () => check,
        Sync: ({ manifest }) => sync(manifest)
      })
    ),
    Effect.provide(ModelsCheckLive),
    Effect.catchTags({
      ModelsCheckUsageError: error => exitWithError(error.message),
      ModelsCheckReadError: error => exitWithError(`models:check: ${error.message}`),
      ModelsCheckWriteError: error => exitWithError(`models:check: ${error.message}`)
    })
  )

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  // Every typed failure is handled above; this catches only a defect (a bug in this script).
  Effect.runPromise(modelsCheckCli(process.argv.slice(2))).catch(error => {
    console.error('models:check failed unexpectedly:', error)
    process.exitCode = 1
  })
}
