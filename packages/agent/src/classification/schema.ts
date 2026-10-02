import * as Schema from 'effect/Schema'

/** Most named options one `choice` question may offer. */
export const maxClassifierChoiceOptions = 255

/** Fewest named options one `choice` question must offer. */
export const minClassifierChoiceOptions = 2

/** Fewest ordinal levels one `score` question must offer. */
export const minClassifierScoreLevels = 2

/** Most ordinal levels one `score` question may offer. */
export const maxClassifierScoreLevels = 10

/** What a criterion describes: a plain-language description or any JSON value. */
export const ClassifierCriterion = Schema.Json

export type ClassifierCriterion = typeof ClassifierCriterion.Type

/** A yes/no question. `criteria` optionally describes what `true` and `false` mean. */
export const BooleanClassifierQuestion = Schema.Struct({
  type: Schema.Literal('boolean'),
  instructions: Schema.NonEmptyString,
  criteria: Schema.optionalKey(Schema.Struct({ true: Schema.String, false: Schema.String }))
})

export type BooleanClassifierQuestion = typeof BooleanClassifierQuestion.Type

/** One of named options: `criteria` maps each option key to what it means (2 to 255 options). */
export const ChoiceClassifierQuestion = Schema.Struct({
  type: Schema.Literal('choice'),
  instructions: Schema.NonEmptyString,
  criteria: Schema.Record(Schema.NonEmptyString, ClassifierCriterion).check(
    Schema.isPropertiesLengthBetween(minClassifierChoiceOptions, maxClassifierChoiceOptions)
  )
})

export type ChoiceClassifierQuestion = typeof ChoiceClassifierQuestion.Type

/** Ordinal levels, lowest first: `criteria` describes each level (2 to 10 levels). */
export const ScoreClassifierQuestion = Schema.Struct({
  type: Schema.Literal('score'),
  instructions: Schema.NonEmptyString,
  criteria: Schema.NonEmptyArray(ClassifierCriterion).check(
    Schema.isLengthBetween(minClassifierScoreLevels, maxClassifierScoreLevels)
  )
})

export type ScoreClassifierQuestion = typeof ScoreClassifierQuestion.Type

export const ClassifierQuestion = Schema.Union([
  BooleanClassifierQuestion,
  ChoiceClassifierQuestion,
  ScoreClassifierQuestion
])

export type ClassifierQuestion = typeof ClassifierQuestion.Type

export type ClassifierQuestionType = ClassifierQuestion['type']

/** Named questions answered together about one state; at least one. */
export const ClassifierQuestions = Schema.Record(Schema.NonEmptyString, ClassifierQuestion).check(
  Schema.isMinProperties(1)
)

export type ClassifierQuestions = typeof ClassifierQuestions.Type

/** The one value a classification is about: a string, a JSON object, or a JSON array. */
export const ClassifierState = Schema.Union([
  Schema.String,
  Schema.JsonObject,
  Schema.Array(Schema.Json)
])

export type ClassifierState = typeof ClassifierState.Type

/** A finite probability in `[0, 1]`, kept exactly as the provider returned it. */
export const ClassifierProbability = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 })
)

/** Probabilities by option key (choice) or level (score); never renormalized. */
export const ClassifierProbabilities = Schema.Record(Schema.String, ClassifierProbability)

export type ClassifierProbabilities = typeof ClassifierProbabilities.Type

export const BooleanClassifierAnswer = Schema.Struct({
  type: Schema.Literal('boolean'),
  /** Probability that the answer is `true`. */
  probability: ClassifierProbability
})

export type BooleanClassifierAnswer = typeof BooleanClassifierAnswer.Type

export const ChoiceClassifierAnswer = Schema.Struct({
  type: Schema.Literal('choice'),
  /** The chosen option key; always one of the question's `criteria` keys. */
  choice: Schema.String,
  probabilities: ClassifierProbabilities,
  confidence: Schema.optionalKey(ClassifierProbability)
})

export type ChoiceClassifierAnswer = typeof ChoiceClassifierAnswer.Type

export const ScoreClassifierAnswer = Schema.Struct({
  type: Schema.Literal('score'),
  /** The chosen level, as the provider returned it. */
  score: Schema.Finite,
  probabilities: ClassifierProbabilities,
  confidence: Schema.optionalKey(ClassifierProbability)
})

export type ScoreClassifierAnswer = typeof ScoreClassifierAnswer.Type

export const ClassifierAnswer = Schema.Union([
  BooleanClassifierAnswer,
  ChoiceClassifierAnswer,
  ScoreClassifierAnswer
])

export type ClassifierAnswer = typeof ClassifierAnswer.Type

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Billed usage of one classification; recorded even when its answers fail to decode. */
export const ClassificationUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  /** Provider-reported cost in US dollars, when the provider reports one. */
  costUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
})

export type ClassificationUsage = typeof ClassificationUsage.Type

/** One classification: a state and the named questions to answer about it. */
export const ClassificationRequest = Schema.Struct({
  state: ClassifierState,
  questions: ClassifierQuestions,
  /** Provider-specific options, passed through unchanged (for example `{ gateway: { ... } }`). */
  providerOptions: Schema.optionalKey(Schema.JsonObject)
})

export type ClassificationRequest = typeof ClassificationRequest.Type

export const ClassificationResult = Schema.Struct({
  /** The model that answered, as the provider reported it. */
  model: Schema.NonEmptyString,
  /** One answer per question id, with the question's type. */
  answers: Schema.Record(Schema.String, ClassifierAnswer),
  usage: Schema.optionalKey(ClassificationUsage),
  providerMetadata: Schema.optionalKey(Schema.JsonObject)
})

export type ClassificationResult = typeof ClassificationResult.Type
