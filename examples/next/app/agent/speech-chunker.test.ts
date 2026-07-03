import { describe, expect, it } from '@effect/vitest'
import { appendSpeechTextDelta, emptySpeechChunkerState, flushSpeechText } from './speech-chunker'

describe('speech chunker', () => {
  it('keeps short fragments pending', () => {
    const result = appendSpeechTextDelta(emptySpeechChunkerState, 'Short sentence.')

    expect(result.chunks).toEqual([])
    expect(result.state.pending).toBe('Short sentence.')
  })

  it('flushes completed sentences after enough text', () => {
    const result = appendSpeechTextDelta(
      emptySpeechChunkerState,
      'This is the first spoken sentence. This stays pending'
    )

    expect(result.chunks).toEqual(['This is the first spoken sentence.'])
    expect(result.state.pending).toBe('This stays pending')
  })

  it('flushes multiple completed sentences from one delta', () => {
    const result = appendSpeechTextDelta(
      emptySpeechChunkerState,
      'This is the first spoken sentence. This is the second spoken sentence! tail'
    )

    expect(result.chunks).toEqual([
      'This is the first spoken sentence.',
      'This is the second spoken sentence!'
    ])
    expect(result.state.pending).toBe('tail')
  })

  it('forces long text without punctuation at a word boundary', () => {
    const result = appendSpeechTextDelta(emptySpeechChunkerState, 'word '.repeat(70))

    expect(result.chunks).toEqual([
      'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word'
    ])
    expect(result.state.pending).toBe('word '.repeat(14))
  })

  it('flushes final pending text', () => {
    const result = flushSpeechText({ pending: 'last partial answer' })

    expect(result.chunks).toEqual(['last partial answer'])
    expect(result.state).toEqual(emptySpeechChunkerState)
  })
})
