export type SpeechChunkerState = {
  readonly pending: string
}

export type SpeechChunkerResult = {
  readonly state: SpeechChunkerState
  readonly chunks: ReadonlyArray<string>
}

export const emptySpeechChunkerState: SpeechChunkerState = { pending: '' }

const minSpeechChunkChars = 24
const maxSpeechChunkChars = 280
const whitespace = /\s/u
const terminalMarks = new Set(['.', '!', '?', '…'])
const closingMarks = new Set(['"', "'", '”', '’', ')', ']', '}'])

const isWhitespace = (value: string | undefined) => value !== undefined && whitespace.test(value)

const sentenceBoundaryEnd = (text: string, markIndex: number) => {
  let end = markIndex + 1

  while (closingMarks.has(text[end] ?? '')) {
    end += 1
  }

  const next = text[end]

  return next === undefined || isWhitespace(next) ? end : -1
}

const findSentenceBoundary = (text: string) => {
  const limit = Math.min(text.length, maxSpeechChunkChars)

  for (let index = minSpeechChunkChars - 1; index < limit; index += 1) {
    const value = text[index]

    if (value === '\n') {
      return index + 1
    }

    if (value !== undefined && terminalMarks.has(value)) {
      const end = sentenceBoundaryEnd(text, index)

      if (end !== -1) {
        return end
      }
    }
  }

  return -1
}

const forcedBoundary = (text: string) => {
  if (text.length < maxSpeechChunkChars) {
    return -1
  }

  const lastSpace = text.lastIndexOf(' ', maxSpeechChunkChars)

  return lastSpace >= minSpeechChunkChars ? lastSpace : maxSpeechChunkChars
}

export const appendSpeechTextDelta = (
  state: SpeechChunkerState,
  text: string
): SpeechChunkerResult => {
  let pending = `${state.pending}${text}`.trimStart()
  const chunks: Array<string> = []

  while (pending.length > 0) {
    const sentenceEnd = findSentenceBoundary(pending)
    const boundary = sentenceEnd === -1 ? forcedBoundary(pending) : sentenceEnd

    if (boundary === -1) {
      break
    }

    const chunk = pending.slice(0, boundary).trim()
    pending = pending.slice(boundary).trimStart()

    if (chunk.length > 0) {
      chunks.push(chunk)
    }
  }

  return { state: { pending }, chunks }
}

export const flushSpeechText = (state: SpeechChunkerState): SpeechChunkerResult => {
  const chunk = state.pending.trim()

  return {
    state: emptySpeechChunkerState,
    chunks: chunk.length > 0 ? [chunk] : []
  }
}
