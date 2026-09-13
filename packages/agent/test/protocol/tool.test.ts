import { describe, expect, it } from '@effect/vitest'
import {
  makeErrorToolResult,
  plainQuestionAnswer,
  plainQuestionResponse,
  plainToolApprovalResponse,
  questionResponseStructuredContent,
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalResponse
} from '../../src/protocol'

describe('tool protocol helpers', () => {
  it('creates handled error tool results', () => {
    const result = makeErrorToolResult({
      toolCallId: 'call_1',
      content: 'Missing resource',
      structuredContent: { code: 'missing_resource' }
    })

    expect(result).toMatchObject({
      toolCallId: 'call_1',
      content: 'Missing resource',
      isError: true,
      structuredContent: { code: 'missing_resource' }
    })
  })

  it('omits structuredContent when absent and preserves JSON key order when present', () => {
    const omitted = makeErrorToolResult({
      toolCallId: 'call_1',
      content: 'boom'
    })

    expect(Object.keys(omitted)).toEqual(['toolCallId', 'content', 'isError'])
    expect(JSON.stringify(omitted)).toBe('{"toolCallId":"call_1","content":"boom","isError":true}')
    expect(Object.hasOwn(omitted, 'structuredContent')).toBe(false)

    const present = makeErrorToolResult({
      toolCallId: 'call_1',
      content: 'boom',
      structuredContent: { code: 'x' }
    })

    expect(Object.keys(present)).toEqual(['toolCallId', 'content', 'isError', 'structuredContent'])
    expect(JSON.stringify(present)).toBe(
      '{"toolCallId":"call_1","content":"boom","isError":true,"structuredContent":{"code":"x"}}'
    )
  })

  it('omits optional HITL fields and preserves JSON key order, copies, getter reads, and source tail', () => {
    const madeAnswer = QuestionAnswer.make({
      questionId: 'choice',
      optionIds: ['a'],
      customAnswer: 'other'
    })

    const omittedAnswer = plainQuestionAnswer(QuestionAnswer.make({ questionId: 'choice' }))
    const presentAnswer = plainQuestionAnswer(madeAnswer)

    expect(Object.keys(omittedAnswer)).toEqual(['questionId'])
    expect(JSON.stringify(omittedAnswer)).toBe('{"questionId":"choice"}')
    expect(Object.hasOwn(omittedAnswer, 'optionIds')).toBe(false)
    expect(Object.hasOwn(omittedAnswer, 'customAnswer')).toBe(false)
    expect(Object.keys(presentAnswer)).toEqual(['questionId', 'optionIds', 'customAnswer'])
    expect(JSON.stringify(presentAnswer)).toBe(
      '{"questionId":"choice","optionIds":["a"],"customAnswer":"other"}'
    )
    expect(presentAnswer.optionIds).not.toBe(madeAnswer.optionIds)

    let optionIdReads = 0
    const counted = QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })
    const countedOptionIds = counted.optionIds
    Object.defineProperty(counted, 'optionIds', {
      configurable: true,
      enumerable: true,
      get: () => {
        optionIdReads += 1

        return countedOptionIds
      }
    })
    const countedPlain = plainQuestionAnswer(counted)
    expect(optionIdReads).toBe(2)
    expect(countedPlain.optionIds).not.toBe(countedOptionIds)

    const omittedResponse = plainQuestionResponse(
      QuestionResponse.make({
        requestId: 'question:call_1',
        toolCallId: 'call_1',
        outcome: 'answered',
        source: 'user'
      })
    )

    const presentResponse = plainQuestionResponse(
      QuestionResponse.make({
        requestId: 'question:call_1',
        toolCallId: 'call_1',
        outcome: 'answered',
        source: 'user',
        answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })],
        reason: 'ok'
      })
    )

    expect(Object.keys(omittedResponse)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'outcome',
      'source'
    ])
    expect(JSON.stringify(omittedResponse)).toBe(
      '{"_tag":"QuestionResponse","requestId":"question:call_1","toolCallId":"call_1","outcome":"answered","source":"user"}'
    )
    expect(Object.keys(presentResponse)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'outcome',
      'source',
      'answers',
      'reason'
    ])

    const omittedApproval = plainToolApprovalResponse(
      ToolApprovalResponse.make({
        requestId: 'approval:call_1',
        toolCallId: 'call_1',
        decision: 'approved',
        source: 'user'
      })
    )

    const presentApproval = plainToolApprovalResponse(
      ToolApprovalResponse.make({
        requestId: 'approval:call_1',
        toolCallId: 'call_1',
        decision: 'denied',
        source: 'user',
        reason: 'unsafe'
      })
    )

    expect(Object.keys(omittedApproval)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'decision',
      'source'
    ])
    expect(Object.hasOwn(omittedApproval, 'reason')).toBe(false)
    expect(Object.keys(presentApproval)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'decision',
      'source',
      'reason'
    ])

    const omittedStructured = questionResponseStructuredContent(
      QuestionResponse.make({
        requestId: 'question:call_1',
        toolCallId: 'call_1',
        outcome: 'answered',
        source: 'user'
      })
    )

    const presentStructured = questionResponseStructuredContent(
      QuestionResponse.make({
        requestId: 'question:call_1',
        toolCallId: 'call_1',
        outcome: 'cancelled',
        source: 'policy',
        reason: 'skip'
      })
    )

    expect(Object.keys(omittedStructured)).toEqual(['type', 'outcome', 'answers', 'source'])
    expect(JSON.stringify(omittedStructured)).toBe(
      '{"type":"question_response","outcome":"answered","answers":[],"source":"user"}'
    )
    expect(Object.keys(presentStructured)).toEqual([
      'type',
      'outcome',
      'answers',
      'reason',
      'source'
    ])
    expect(JSON.stringify(presentStructured)).toBe(
      '{"type":"question_response","outcome":"cancelled","answers":[],"reason":"skip","source":"policy"}'
    )

    const omittedTrace = QuestionResponse.make({
      requestId: 'question:call_1',
      toolCallId: 'call_1',
      outcome: 'answered',
      source: 'user'
    })

    const omittedReads: Array<string> = []
    Object.defineProperty(omittedTrace, 'reason', {
      configurable: true,
      enumerable: true,
      get: () => {
        omittedReads.push('reason')

        return undefined
      }
    })
    Object.defineProperty(omittedTrace, 'source', {
      configurable: true,
      enumerable: true,
      get: () => {
        omittedReads.push('source')

        return 'user'
      }
    })
    const omittedTraced = questionResponseStructuredContent(omittedTrace)
    expect(omittedReads).toEqual(['reason', 'source'])
    expect(Object.keys(omittedTraced)).toEqual(['type', 'outcome', 'answers', 'source'])

    const presentTrace = QuestionResponse.make({
      requestId: 'question:call_1',
      toolCallId: 'call_1',
      outcome: 'cancelled',
      source: 'policy',
      reason: 'skip'
    })

    const presentReads: Array<string> = []
    Object.defineProperty(presentTrace, 'reason', {
      configurable: true,
      enumerable: true,
      get: () => {
        presentReads.push('reason')

        return 'skip'
      }
    })
    Object.defineProperty(presentTrace, 'source', {
      configurable: true,
      enumerable: true,
      get: () => {
        presentReads.push('source')

        return 'policy'
      }
    })
    const presentTraced = questionResponseStructuredContent(presentTrace)
    expect(presentReads).toEqual(['reason', 'reason', 'source'])
    expect(Object.keys(presentTraced)).toEqual(['type', 'outcome', 'answers', 'reason', 'source'])
  })
})
