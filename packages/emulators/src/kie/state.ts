/**
 * Kie emulator state: the finished task records `recordInfo` answers, the task ids it answers the
 * recorded not-found envelope for, the digests of the API keys a seed marks as rejected, the tasks
 * created through the recorded create flows, and the created-id counter, with the seed input and
 * the default seed (internal; re-exported by `src/kie.ts`).
 *
 * The default entities are the synthetic Kie conformance fixtures, copied as data (the success and
 * failed task records, the absent task id), never imported from SDK code. The default rejected key
 * is the synthetic invalid key the unauthorized case sends (no account data). Every rendered answer
 * keeps the fixtures' key order.
 *
 * Rejected keys are never kept: the state holds only their digests (SHA-256 of the origin, a space,
 * and the key), so a rejected key a request carries as its bearer reaches neither the state nor
 * `/_emulate/*`. Created tasks are recorded in the state (a create is irreversible on Kie) and are
 * never readable: no fixture records a created task's `recordInfo`. Created ids come from a counter
 * in the state that only advances, in the fixtures' minted form, which no seeded id may use.
 *
 * @experimental
 */
import { createHash } from 'node:crypto'
import { Match, Predicate, Result, type SchemaIssue } from 'effect'
import * as Schema from 'effect/Schema'
import { isRecognisableBearerValue } from '../stateful-secrets.ts'

/** The origin every Kie fixture records; another origin is not emulated. */
export const kieEmulatorOrigin = 'https://api.kie.ai'

/** The minted created-task id form: this prefix and a counter of four digits. */
export const kieEmulatorCreatedIdPrefix = 'yolk_synthetic_task_created_'

/** The largest created-task counter (`..._9999`); a create beyond it is refused before any fault. */
export const kieEmulatorMaxCreated = 9999

/** A created task id from its counter value (`yolk_synthetic_task_created_0001`). */
export const kieEmulatorCreatedId = (counter: number): string =>
  `${kieEmulatorCreatedIdPrefix}${String(counter).padStart(4, '0')}`

/** The minted form no seeded id may take. */
const mintedIdPattern = /^yolk_synthetic_task_created_\d+$/u

/**
 * The per-origin digest of an API key: SHA-256 (hex) of the origin, a space, and the key. Neither
 * an origin nor a recognisable bearer holds a space, so distinct pairs never share a text.
 */
export const kieKeyDigest = (key: string, origin: string): string =>
  createHash('sha256').update(`${origin} ${key}`, 'utf8').digest('hex')

/** A task id in the characters the connector's cases send (a query value). */
export const kieTaskIdPattern = /^[A-Za-z0-9_-]{1,128}$/u

const TaskId = Schema.String.check(Schema.isPattern(kieTaskIdPattern))

/** A SHA-256 digest (64 lower-case hex digits). */
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

const NullableString = Schema.NullOr(Schema.String)

const NullableNumber = Schema.NullOr(Schema.Number)

/** A finished task record `recordInfo` answers, in the fixtures' fields (null where recorded). */
export const KieEmulatorTask = Schema.Struct({
  taskId: TaskId,
  model: Schema.String,
  state: Schema.Literals(['success', 'fail']),
  resultJson: NullableString,
  failCode: NullableString,
  failMsg: NullableString,
  costTime: NullableNumber,
  completeTime: NullableNumber,
  createTime: NullableNumber,
  updateTime: NullableNumber
})

export type KieEmulatorTask = typeof KieEmulatorTask.Type

/** A task created through a recorded create flow: its minted id, model, and input as sent. */
export const KieEmulatorCreatedTask = Schema.Struct({
  taskId: Schema.String,
  model: Schema.String,
  input: Schema.Record(Schema.String, Schema.Json)
})

export type KieEmulatorCreatedTask = typeof KieEmulatorCreatedTask.Type

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const KieEmulatorStateSchema = Schema.Struct({
  /** Digests of the keys Kie answers with the recorded 401. */
  rejectedKeyDigests: Schema.Array(Digest),
  tasks: Schema.Array(KieEmulatorTask),
  /** Task ids that name no task: their `recordInfo` answers the recorded not-found envelope. */
  absentTaskIds: Schema.Array(TaskId),
  /** Tasks created here, in order (a create is irreversible; never readable). */
  createdTasks: Schema.Array(KieEmulatorCreatedTask),
  /** The counter value of the next created task id (only advances). */
  nextCreated: Schema.Int
})

/** The state a commit writes (whole fields replaced, never edited in place). */
export type KieEmulatorState = {
  rejectedKeyDigests: ReadonlyArray<string>
  tasks: ReadonlyArray<KieEmulatorTask>
  absentTaskIds: ReadonlyArray<string>
  createdTasks: ReadonlyArray<KieEmulatorCreatedTask>
  nextCreated: number
}

/**
 * A typed seed: every key, when given, replaces that part of the default seed (the fixture
 * entities). Rejected keys are given as keys and kept only as their digests.
 */
export const KieEmulatorSeed = Schema.Struct({
  rejectedKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  tasks: Schema.optionalKey(Schema.Array(KieEmulatorTask)),
  absentTaskIds: Schema.optionalKey(Schema.Array(TaskId))
})

export type KieEmulatorSeed = typeof KieEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(KieEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(KieEmulatorStateSchema, strict)

/** Every field name the seed and state schemas define (the only names a seed error may print). */
const knownFieldNames: ReadonlySet<string> = new Set([
  ...Object.keys(KieEmulatorSeed.fields),
  ...Object.keys(KieEmulatorStateSchema.fields),
  ...Object.keys(KieEmulatorTask.fields),
  ...Object.keys(KieEmulatorCreatedTask.fields)
])

/**
 * A field path in constant text: array indices and the schemas' own field names as written, any
 * other key (one a seed made up, which may be anything, a key included) as `<unexpected key>`.
 */
const fieldPath = (path: ReadonlyArray<PropertyKey>): string => {
  const text = path
    .map(segment =>
      Predicate.isNumber(segment)
        ? `[${segment}]`
        : Predicate.isString(segment) && knownFieldNames.has(segment)
          ? `.${segment}`
          : '.<unexpected key>'
    )
    .join('')
    .replace(/^\./, '')

  return text === '' ? 'the seed root' : text
}

/** The category of a leaf issue, in constant text. */
const issueCategory = (tag: SchemaIssue.Issue['_tag']): string => {
  switch (tag) {
    case 'MissingKey':
      return 'missing key'
    case 'UnexpectedKey':
      return 'unexpected key'
    case 'InvalidType':
      return 'invalid type'
    case 'AnyOf':
    case 'OneOf':
      return 'no matching member'
    case 'Forbidden':
      return 'forbidden value'
    default:
      return 'invalid value'
  }
}

type Leaf = { readonly issue: SchemaIssue.Issue; readonly path: ReadonlyArray<PropertyKey> }

/** The first leaf issue under `issue`, with its full path. */
const firstLeaf = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): Leaf =>
  Match.value(issue).pipe(
    Match.tag('Pointer', pointer => firstLeaf(pointer.issue, [...path, ...pointer.path])),
    Match.tag('Filter', filter => firstLeaf(filter.issue, path)),
    Match.tag('Encoding', encoding => firstLeaf(encoding.issue, path)),
    Match.tag('Composite', composite => firstLeaf(composite.issues[0], path)),
    Match.tag('AnyOf', anyOf => {
      const [first] = anyOf.issues

      return first === undefined ? { issue: anyOf, path } : firstLeaf(first, path)
    }),
    Match.orElse(leaf => ({ issue: leaf, path }))
  )

/**
 * Why a seed does not decode, in constant text only: the category of the first issue and its
 * field path, never the input (Effect's own messages quote input values, and a seed may carry
 * keys). An unexpected key is reported at its parent's path.
 */
const issueReason = (root: SchemaIssue.Issue): string => {
  const { issue, path } = firstLeaf(root, [])
  const where = Predicate.isTagged(issue, 'UnexpectedKey') ? path.slice(0, -1) : path

  return `${issueCategory(issue._tag)} at ${fieldPath(where)}`
}

// Default entities, copied from the fixtures.

const defaultTasks: ReadonlyArray<KieEmulatorTask> = [
  // The get-success fixture.
  {
    taskId: 'yolk_synthetic_task_success_0001',
    model: 'gpt-image-2-text-to-image',
    state: 'success',
    resultJson: JSON.stringify({
      resultUrls: ['https://tempfile.example.com/yolk-synthetic/image-0001.png']
    }),
    failCode: null,
    failMsg: null,
    costTime: 12000,
    completeTime: 1790000012000,
    createTime: 1790000000000,
    updateTime: 1790000012000
  },
  // The get-failed fixture.
  {
    taskId: 'yolk_synthetic_task_failed_0001',
    model: 'gpt-image-2-text-to-image',
    state: 'fail',
    resultJson: null,
    failCode: '500',
    failMsg: 'synthetic generation failure',
    costTime: null,
    completeTime: 1790000020000,
    createTime: 1790000000000,
    updateTime: 1790000020000
  }
]

const defaultAbsentTaskIds: ReadonlyArray<string> = ['yolk_conformance_absent_task_0000']

/** The synthetic invalid key the unauthorized case sends (never account data). */
export const kieEmulatorDefaultRejectedKeys: ReadonlyArray<string> = [
  'yolk-conformance-invalid-kie-key'
]

/** The index of the first value equal to an earlier one, or `-1`. */
const repeatIndex = <A>(values: ReadonlyArray<A>): number =>
  values.findIndex((value, index) => values.indexOf(value) !== index)

type SeedParts = {
  readonly rejectedKeys: ReadonlyArray<string>
  readonly tasks: ReadonlyArray<KieEmulatorTask>
  readonly absentTaskIds: ReadonlyArray<string>
}

/**
 * Integrity problems a decoded seed can still have, in constant text only (a category and a field
 * path, never a seeded value: a seed may carry keys anywhere).
 */
const seedProblem = (parts: SeedParts): string | undefined => {
  const ids = [...parts.tasks.map(task => task.taskId), ...parts.absentTaskIds]
  const repeated = repeatIndex(ids)

  if (repeated !== -1) {
    return repeated < parts.tasks.length
      ? `duplicate task id at tasks[${repeated}].taskId`
      : `duplicate task id at absentTaskIds[${repeated - parts.tasks.length}]`
  }

  const minted = ids.findIndex(id => mintedIdPattern.test(id))

  if (minted !== -1) {
    return minted < parts.tasks.length
      ? `a minted created-task id at tasks[${minted}].taskId`
      : `a minted created-task id at absentTaskIds[${minted - parts.tasks.length}]`
  }

  const unrecognisable = parts.rejectedKeys.findIndex(key => !isRecognisableBearerValue(key))

  if (unrecognisable !== -1) {
    return `not a recognisable bearer value at rejectedKeys[${unrecognisable}]`
  }

  const repeatedKey = repeatIndex(parts.rejectedKeys)

  return repeatedKey === -1 ? undefined : `duplicate key at rejectedKeys[${repeatedKey}]`
}

const stateFromSeed = (seed: KieEmulatorSeed): KieEmulatorState | string => {
  const parts: SeedParts = {
    rejectedKeys: seed.rejectedKeys ?? kieEmulatorDefaultRejectedKeys,
    tasks: seed.tasks ?? defaultTasks,
    absentTaskIds: seed.absentTaskIds ?? defaultAbsentTaskIds
  }

  return (
    seedProblem(parts) ?? {
      rejectedKeyDigests: parts.rejectedKeys.map(key => kieKeyDigest(key, kieEmulatorOrigin)),
      tasks: parts.tasks,
      absentTaskIds: parts.absentTaskIds,
      createdTasks: [],
      nextCreated: 1
    }
  )
}

/**
 * Decode and build a seed; a string is the reason it is invalid, in constant text only (a
 * category and a field path; never an input value or a key the seed made up).
 */
export const buildSeedState = (input: unknown): KieEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueReason(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid (constant). */
export const decodeState = (input: unknown): KieEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueReason(decoded.failure.issue) : decoded.success
}
