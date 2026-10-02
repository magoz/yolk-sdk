import { Context, Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ClassificationRequestInvalid,
  ClassificationResponseInvalid,
  type ClassificationAnswerIssueReason,
  type ClassificationError
} from './error.ts'
import {
  ClassificationRequest,
  type BooleanClassifierAnswer,
  type ChoiceClassifierAnswer,
  type ClassificationResult,
  type ClassifierAnswer,
  type ClassifierProbabilities,
  type ClassifierQuestion,
  type ScoreClassifierAnswer
} from './schema.ts'

/**
 * Answers typed questions about one state. Classification is a read: it has no side effects.
 * Providers supply layers; `classify` is the typed entry point.
 */
export class ClassifierModel extends Context.Service<
  ClassifierModel,
  {
    readonly classify: (
      request: ClassificationRequest
    ) => Effect.Effect<ClassificationResult, ClassificationError>
  }
>()('@yolk-sdk/agent/classification/ClassifierModel') {}

/** Named questions, typed for inference. */
export type ClassifierQuestionsInput = { readonly [questionId: string]: ClassifierQuestion }

/** The answer type a question gets; a choice answer's `choice` is the union of its option keys. */
export type ClassifierAnswerFor<Q extends ClassifierQuestion> = Q extends {
  readonly type: 'boolean'
}
  ? BooleanClassifierAnswer
  : Q extends { readonly type: 'choice'; readonly criteria: infer Criteria }
    ? ChoiceClassifierAnswer & { readonly choice: Extract<keyof Criteria, string> }
    : ScoreClassifierAnswer

export type ClassifierAnswersFor<Q extends ClassifierQuestionsInput> = {
  readonly [K in keyof Q]: ClassifierAnswerFor<Q[K]>
}

export type ClassificationRequestFor<Q extends ClassifierQuestionsInput> = Omit<
  ClassificationRequest,
  'questions'
> & { readonly questions: Q }

export type ClassificationResultFor<Q extends ClassifierQuestionsInput> = ClassificationResult & {
  readonly answers: ClassifierAnswersFor<Q>
}

/** Where an answer leaves its question. */
export type ClassificationAnswerIssue = {
  readonly reason: ClassificationAnswerIssueReason
  readonly questionId: string
}

const isProbability = (value: unknown): value is number =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 1

const isFieldObject = (value: unknown): value is object =>
  Predicate.isObject(value) && !Array.isArray(value)

/** An own field of a JSON object, never an inherited one (`toString`, `__proto__`). */
const ownField = (value: object, key: string): unknown =>
  Object.hasOwn(value, key) && Predicate.hasProperty(value, key) ? value[key] : undefined

const decodeProbabilities = (
  value: unknown
): Result.Result<ClassifierProbabilities, ClassificationAnswerIssueReason> => {
  if (!isFieldObject(value)) return Result.fail('invalid_probability')

  const probabilities: Record<string, number> = {}

  for (const key of Object.keys(value)) {
    const probability = ownField(value, key)

    if (!isProbability(probability)) return Result.fail('invalid_probability')

    probabilities[key] = probability
  }

  return Result.succeed(probabilities)
}

type ConfidenceField = { confidence?: number }

const decodeConfidence = (
  raw: object,
  fields: ConfidenceField
): ClassificationAnswerIssueReason | undefined => {
  if (!Object.hasOwn(raw, 'confidence')) return undefined

  const confidence = ownField(raw, 'confidence')

  if (!isProbability(confidence)) return 'invalid_confidence'

  fields.confidence = confidence

  return undefined
}

/**
 * Decode one raw provider answer against the question it answers. The answer must be an object
 * whose `type` is the question's; probabilities and confidence must be finite numbers in `[0, 1]`
 * and are kept exactly as given (never renormalized); a choice must name one of the question's
 * options; a score must be finite. Only the contract fields are kept.
 */
export const decodeClassifierAnswer = (
  question: ClassifierQuestion,
  raw: unknown
): Result.Result<ClassifierAnswer, ClassificationAnswerIssueReason> => {
  if (!isFieldObject(raw)) return Result.fail('malformed_answer')

  if (ownField(raw, 'type') !== question.type) return Result.fail('type_mismatch')

  if (question.type === 'boolean') {
    const probability = ownField(raw, 'probability')

    return isProbability(probability)
      ? Result.succeed({ type: 'boolean', probability })
      : Result.fail('invalid_probability')
  }

  const probabilities = decodeProbabilities(ownField(raw, 'probabilities'))

  if (Result.isFailure(probabilities)) return Result.fail(probabilities.failure)

  if (question.type === 'choice') {
    const choice = ownField(raw, 'choice')

    if (!Predicate.isString(choice) || !Object.hasOwn(question.criteria, choice)) {
      return Result.fail('invalid_choice')
    }

    const fields: ChoiceClassifierAnswer & ConfidenceField = {
      type: 'choice',
      choice,
      probabilities: probabilities.success
    }

    const issue = decodeConfidence(raw, fields)

    return issue === undefined ? Result.succeed(fields) : Result.fail(issue)
  }

  const score = ownField(raw, 'score')

  if (!Predicate.isNumber(score) || !Number.isFinite(score)) return Result.fail('invalid_score')

  const fields: ScoreClassifierAnswer & ConfidenceField = {
    type: 'score',
    score,
    probabilities: probabilities.success
  }

  const issue = decodeConfidence(raw, fields)

  return issue === undefined ? Result.succeed(fields) : Result.fail(issue)
}

/**
 * Decode raw provider answers (a JSON object keyed by question id) against the questions asked:
 * every question needs exactly one answer of its type, and no answer may name a question that was
 * not asked. Fails with the first issue, in question order (then unexpected answers); answers that
 * are not an object fail as the first question's `malformed_answer`.
 */
export const decodeClassifierAnswers = (
  questions: ClassifierQuestionsInput,
  raw: unknown
): Result.Result<Record<string, ClassifierAnswer>, ClassificationAnswerIssue> => {
  const questionIds = Object.keys(questions)

  if (!isFieldObject(raw)) {
    return Result.fail({ reason: 'malformed_answer', questionId: questionIds[0] ?? '' })
  }

  const answers: Record<string, ClassifierAnswer> = {}

  for (const [questionId, question] of Object.entries(questions)) {
    if (!Object.hasOwn(raw, questionId)) {
      return Result.fail({ reason: 'missing_answer', questionId })
    }

    const answer = decodeClassifierAnswer(question, ownField(raw, questionId))

    if (Result.isFailure(answer)) return Result.fail({ reason: answer.failure, questionId })

    answers[questionId] = answer.success
  }

  for (const questionId of Object.keys(raw)) {
    if (!Object.hasOwn(questions, questionId)) {
      return Result.fail({ reason: 'unexpected_answer', questionId })
    }
  }

  return Result.succeed(answers)
}

/** The first way `answers` leaves `questions`, or undefined when every answer fits its question. */
export const classificationAnswersIssue = (
  questions: ClassifierQuestionsInput,
  answers: { readonly [questionId: string]: ClassifierAnswer }
): ClassificationAnswerIssue | undefined => {
  const decoded = decodeClassifierAnswers(questions, answers)

  return Result.isFailure(decoded) ? decoded.failure : undefined
}

/** Narrow a result to the answer types its questions infer, after checking every answer. */
export const isClassificationResultFor = <const Q extends ClassifierQuestionsInput>(
  questions: Q,
  result: ClassificationResult
): result is ClassificationResultFor<Q> =>
  classificationAnswersIssue(questions, result.answers) === undefined

/**
 * Validate a request against the classification contract before anything is sent. Fails with
 * `ClassificationRequestInvalid` (for example a choice with more than 255 options, or a score with
 * more than 10 levels).
 */
export const decodeClassificationRequest = (
  request: unknown
): Effect.Effect<ClassificationRequest, ClassificationRequestInvalid> =>
  Schema.decodeUnknownEffect(ClassificationRequest)(request).pipe(
    Effect.mapError(error =>
      ClassificationRequestInvalid.make({
        message: `Invalid classification request: ${error.message}`
      })
    )
  )

/**
 * Classify with the `ClassifierModel` in context, typing each answer from its question: a choice
 * answer's `choice` is the union of that question's option keys. Every answer is checked against
 * its question; a provider that returns a mismatching answer fails with
 * `ClassificationResponseInvalid` (keeping usage).
 */
export const classify = <const Q extends ClassifierQuestionsInput>(
  request: ClassificationRequestFor<Q>
): Effect.Effect<ClassificationResultFor<Q>, ClassificationError, ClassifierModel> =>
  Effect.gen(function* () {
    const model = yield* ClassifierModel
    const result = yield* model.classify(request)

    if (isClassificationResultFor(request.questions, result)) return result

    const issue = classificationAnswersIssue(request.questions, result.answers)
    const reason = issue?.reason ?? 'malformed_answer'

    return yield* Effect.fail(
      ClassificationResponseInvalid.make({
        message: `Classification answers do not fit their questions: ${reason}`,
        reason,
        questionId: issue?.questionId,
        usage: result.usage
      })
    )
  })
