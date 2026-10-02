import { Effect, Exit, Layer, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import {
  ClassificationRequest,
  ClassificationRequestInvalid,
  ClassificationResponseInvalid,
  ClassificationResult,
  ClassifierAnswer,
  ClassifierModel,
  ClassifierQuestion,
  classificationAnswersIssue,
  classify,
  decodeClassificationRequest,
  decodeClassifierAnswer,
  decodeClassifierAnswers,
  isClassificationResultFor,
  maxClassifierChoiceOptions,
  type ClassificationResult as ClassificationResultType,
  type ClassifierQuestionsInput
} from '../../src/classification/index.ts'

const booleanQuestion = {
  type: 'boolean',
  instructions: 'Does the reply approve the result?',
  criteria: { true: 'Approves.', false: 'Rejects.' }
} as const

const choiceQuestion = {
  type: 'choice',
  instructions: 'Which team handles this?',
  criteria: { billing: 'Payments.', bug: { kind: 'defect', examples: ['crash'] } }
} as const

const scoreQuestion = {
  type: 'score',
  instructions: 'How urgent?',
  criteria: ['Low.', 'Medium.', { level: 'high' }]
} as const

const questions = {
  approves: booleanQuestion,
  route: choiceQuestion,
  urgency: scoreQuestion
} as const

const options = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`option-${index}`, 'An option.']))

const isQuestion = Schema.is(ClassifierQuestion)

describe('classifier questions', () => {
  it('accept every question type, with JSON criteria', () => {
    expect(isQuestion(booleanQuestion)).toBe(true)
    expect(isQuestion({ type: 'boolean', instructions: 'Approve?' })).toBe(true)
    expect(isQuestion(choiceQuestion)).toBe(true)
    expect(isQuestion(scoreQuestion)).toBe(true)
  })

  it('limit choice to 2-255 options and score to 2-10 levels', () => {
    const choice = (count: number) => ({
      type: 'choice',
      instructions: 'Pick one.',
      criteria: options(count)
    })

    const score = (count: number) => ({
      type: 'score',
      instructions: 'Rate it.',
      criteria: Array.from({ length: count }, (_, index) => `Level ${index}.`)
    })

    expect(maxClassifierChoiceOptions).toBe(255)
    expect(isQuestion(choice(1))).toBe(false)
    expect(isQuestion(choice(2))).toBe(true)
    expect(isQuestion(choice(255))).toBe(true)
    expect(isQuestion(choice(256))).toBe(false)
    expect(isQuestion(score(0))).toBe(false)
    expect(isQuestion(score(1))).toBe(false)
    expect(isQuestion(score(2))).toBe(true)
    expect(isQuestion(score(10))).toBe(true)
    expect(isQuestion(score(11))).toBe(false)
  })

  it('reject empty instructions, unknown types, and partial boolean criteria', () => {
    expect(isQuestion({ type: 'boolean', instructions: '' })).toBe(false)
    expect(isQuestion({ type: 'rank', instructions: 'Rank.' })).toBe(false)
    expect(
      isQuestion({ type: 'boolean', instructions: 'Approve?', criteria: { true: 'Yes.' } })
    ).toBe(false)
  })
})

describe('classification requests', () => {
  const isRequest = Schema.is(ClassificationRequest)

  it('take a string, JSON object, or JSON array state (an array is one state)', () => {
    for (const state of ['text', { a: 1 }, [{ a: 1 }, 'two'], []]) {
      expect(isRequest({ state, questions: { approves: booleanQuestion } })).toBe(true)
    }
  })

  it('reject scalar states, no questions, and non-object provider options', () => {
    for (const state of [1, true, null]) {
      expect(isRequest({ state, questions: { approves: booleanQuestion } })).toBe(false)
    }

    expect(isRequest({ state: 'text', questions: {} })).toBe(false)
    expect(
      isRequest({ state: 'text', questions: { approves: booleanQuestion }, providerOptions: [] })
    ).toBe(false)
    expect(
      isRequest({
        state: 'text',
        questions: { approves: booleanQuestion },
        providerOptions: { gateway: { zeroDataRetention: true } }
      })
    ).toBe(true)
  })

  it.effect('decode to a typed ClassificationRequestInvalid', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeClassificationRequest({
          state: 'text',
          questions: {
            route: { type: 'choice', instructions: 'Pick.', criteria: options(256) }
          }
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)

      const error = yield* Effect.flip(decodeClassificationRequest({ state: 1, questions: {} }))

      expect(error).toBeInstanceOf(ClassificationRequestInvalid)
      expect(error.message).toMatch(/^Invalid classification request: /)
    })
  )
})

describe('classifier answers', () => {
  it('decode every question type, keeping question ids, types, and exact probabilities', () => {
    const decoded = decodeClassifierAnswers(questions, {
      approves: { type: 'boolean', probability: 0.93 },
      route: {
        type: 'choice',
        choice: 'bug',
        probabilities: { billing: 0.33, bug: 0.33 },
        confidence: 0.4
      },
      urgency: { type: 'score', score: 2, probabilities: { '0': 0.5, '1': 0.3, '2': 0.4 } }
    })

    // Probabilities are never renormalized: the choice sums to 0.66 and the score to 1.2.
    expect(decoded).toEqual(
      Result.succeed({
        approves: { type: 'boolean', probability: 0.93 },
        route: {
          type: 'choice',
          choice: 'bug',
          probabilities: { billing: 0.33, bug: 0.33 },
          confidence: 0.4
        },
        urgency: { type: 'score', score: 2, probabilities: { '0': 0.5, '1': 0.3, '2': 0.4 } }
      })
    )
  })

  it('keep `__proto__` question ids and option keys as own answers and probabilities', () => {
    // JSON.parse creates own `__proto__` properties, as a provider response body would.
    const specialQuestions = JSON.parse(
      '{"__proto__":{"type":"choice","instructions":"Pick","criteria":{"__proto__":"special","plain":"plain"}}}'
    )

    const raw = JSON.parse(
      '{"__proto__":{"type":"choice","choice":"__proto__","probabilities":{"__proto__":0.8,"plain":0.2}}}'
    )

    const decoded = decodeClassifierAnswers(specialQuestions, raw)

    expect(Result.isSuccess(decoded)).toBe(true)

    if (Result.isSuccess(decoded)) {
      expect(Object.keys(decoded.success)).toEqual(['__proto__'])
      expect(Object.getPrototypeOf(decoded.success)).toBe(Object.prototype)

      const answer = Object.getOwnPropertyDescriptor(decoded.success, '__proto__')?.value

      expect(answer?.type).toBe('choice')
      expect(Object.keys(answer?.probabilities ?? {})).toEqual(['__proto__', 'plain'])
      expect(Object.getOwnPropertyDescriptor(answer?.probabilities, '__proto__')?.value).toBe(0.8)
    }
  })

  it('keep only contract fields', () => {
    expect(
      decodeClassifierAnswer(booleanQuestion, {
        type: 'boolean',
        probability: 0.5,
        extra: 'dropped'
      })
    ).toEqual(Result.succeed({ type: 'boolean', probability: 0.5 }))
  })

  const validAnswers = {
    approves: { type: 'boolean', probability: 0.5 },
    route: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } },
    urgency: { type: 'score', score: 0, probabilities: { '0': 1 } }
  }

  // Raw provider answers: any JSON-ish value under any question id.
  const issueOf = (raw: object) => {
    const decoded = decodeClassifierAnswers(questions, { ...validAnswers, ...raw })

    return Result.isFailure(decoded) ? decoded.failure : undefined
  }

  it('fail closed on a missing answer, an unexpected answer, or a type mismatch', () => {
    expect(
      decodeClassifierAnswers(questions, {
        approves: { type: 'boolean', probability: 0.5 },
        urgency: { type: 'score', score: 0, probabilities: {} }
      })
    ).toEqual(Result.fail({ reason: 'missing_answer', questionId: 'route' }))
    expect(issueOf({ extra: { type: 'boolean', probability: 0.5 } })).toEqual({
      reason: 'unexpected_answer',
      questionId: 'extra'
    })
    expect(issueOf({ approves: { type: 'choice', choice: 'billing', probabilities: {} } })).toEqual(
      {
        reason: 'type_mismatch',
        questionId: 'approves'
      }
    )
    expect(issueOf({ urgency: 'high' })).toEqual({
      reason: 'malformed_answer',
      questionId: 'urgency'
    })
  })

  it('fail closed on non-finite or out-of-range probabilities and confidence', () => {
    for (const probability of [Number.POSITIVE_INFINITY, Number.NaN, -0.1, 1.01, '0.5', null]) {
      expect(issueOf({ approves: { type: 'boolean', probability } })).toEqual({
        reason: 'invalid_probability',
        questionId: 'approves'
      })
    }

    expect(
      issueOf({
        route: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: Number.POSITIVE_INFINITY }
        }
      })
    ).toEqual({ reason: 'invalid_probability', questionId: 'route' })
    expect(issueOf({ route: { type: 'choice', choice: 'billing', probabilities: [1] } })).toEqual({
      reason: 'invalid_probability',
      questionId: 'route'
    })
    expect(
      issueOf({
        urgency: { type: 'score', score: 1, probabilities: {}, confidence: Number.NaN }
      })
    ).toEqual({ reason: 'invalid_confidence', questionId: 'urgency' })
  })

  it('fail closed on a choice that names no option and a non-finite score', () => {
    expect(
      issueOf({ route: { type: 'choice', choice: 'refunds', probabilities: { refunds: 1 } } })
    ).toEqual({ reason: 'invalid_choice', questionId: 'route' })
    expect(issueOf({ route: { type: 'choice', choice: 'toString', probabilities: {} } })).toEqual({
      reason: 'invalid_choice',
      questionId: 'route'
    })
    expect(
      issueOf({
        urgency: { type: 'score', score: Number.POSITIVE_INFINITY, probabilities: {} }
      })
    ).toEqual({ reason: 'invalid_score', questionId: 'urgency' })
  })

  it('answer schemas reject non-finite probabilities', () => {
    expect(Schema.is(ClassifierAnswer)({ type: 'boolean', probability: Number.NaN })).toBe(false)
    expect(Schema.is(ClassifierAnswer)({ type: 'boolean', probability: 0.2 })).toBe(true)
  })
})

const fakeModel = (result: ClassificationResultType) =>
  Layer.succeed(ClassifierModel, ClassifierModel.of({ classify: () => Effect.succeed(result) }))

const validResult: ClassificationResultType = {
  model: 'synthetic/classifier',
  answers: {
    approves: { type: 'boolean', probability: 0.8 },
    route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7, bug: 0.2 } },
    urgency: { type: 'score', score: 1, probabilities: { '1': 0.6 }, confidence: 0.5 }
  },
  usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.00042 }
}

describe('classify', () => {
  it.effect('types each answer from its question', () =>
    Effect.gen(function* () {
      const result = yield* classify({ state: 'synthetic', questions }).pipe(
        Effect.provide(fakeModel(validResult))
      )

      expectTypeOf(result.answers.approves.probability).toEqualTypeOf<number>()
      expectTypeOf(result.answers.route.choice).toEqualTypeOf<'billing' | 'bug'>()
      expectTypeOf(result.answers.urgency.score).toEqualTypeOf<number>()
      expectTypeOf(result.answers.route.type).toEqualTypeOf<'choice'>()

      expect(result.answers.route.choice).toBe('billing')
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0, costUsd: 0.00042 })
      expect(Schema.is(ClassificationResult)(result)).toBe(true)
    })
  )

  it.effect(
    'fails with ClassificationResponseInvalid, keeping usage, when answers do not fit',
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          classify({ state: 'synthetic', questions }).pipe(
            Effect.provide(
              fakeModel({
                ...validResult,
                answers: {
                  ...validResult.answers,
                  route: { type: 'choice', choice: 'refunds', probabilities: {} }
                }
              })
            )
          )
        )

        expect(error).toBeInstanceOf(ClassificationResponseInvalid)
        expect(error).toMatchObject({
          reason: 'invalid_choice',
          questionId: 'route',
          usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.00042 }
        })
      })
  )

  it('narrows a result with a type guard', () => {
    const q: ClassifierQuestionsInput = questions

    expect(isClassificationResultFor(q, validResult)).toBe(true)
    expect(classificationAnswersIssue(questions, {})).toEqual({
      reason: 'missing_answer',
      questionId: 'approves'
    })
  })
})
