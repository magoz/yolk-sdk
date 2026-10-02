import {
  ImagePart,
  inlineBase64AttachmentSource,
  TextPart,
  type Content,
  type NestedToolCallStatus
} from '@yolk-sdk/agent/protocol'
import type { CodeModeExecutionResult, CodeModeOutputItem } from './executor.ts'

/** Text or image piece of the model-visible result, in order. */
export type CodeModeResultSegment = CodeModeOutputItem

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// Cut points never split a surrogate pair.
const headCut = (text: string, length: number) =>
  length > 0 && length < text.length && isHighSurrogate(text.charCodeAt(length - 1))
    ? length - 1
    : length

const tailCut = (text: string, start: number) =>
  start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start

const textLength = (segments: ReadonlyArray<CodeModeResultSegment>) =>
  segments.reduce(
    (total, segment) => total + (segment.type === 'text' ? segment.text.length : 0),
    0
  )

const omissionMarker = (characters: number, images: number) =>
  `\n\n[… ${characters} characters${images > 0 ? ` and ${images} image${images === 1 ? '' : 's'}` : ''} omitted …]\n\n`

const markerReserve = 80

/**
 * Keeps at most about `maxChars` characters of text: the head and the tail of the segments, with an
 * omission marker in between. Images inside the omitted middle are dropped and counted.
 */
export const boundCodeModeSegments = (
  segments: ReadonlyArray<CodeModeResultSegment>,
  maxChars: number
): ReadonlyArray<CodeModeResultSegment> => {
  const total = textLength(segments)

  if (total <= maxChars) return segments

  const budget = Math.max(0, maxChars - markerReserve)
  let headBudget = Math.ceil(budget / 2)
  let tailBudget = budget - headBudget

  const head: Array<CodeModeResultSegment> = []
  let headIndex = 0
  let headPartial = 0

  for (; headIndex < segments.length && headBudget > 0; headIndex++) {
    const segment = segments[headIndex]

    if (segment === undefined) break

    if (segment.type === 'image') {
      head.push(segment)
      continue
    }

    if (segment.text.length <= headBudget) {
      head.push(segment)
      headBudget -= segment.text.length
      continue
    }

    headPartial = headCut(segment.text, headBudget)
    head.push({ type: 'text', text: segment.text.slice(0, headPartial) })
    headBudget = 0
    break
  }

  const tail: Array<CodeModeResultSegment> = []
  let tailIndex = segments.length - 1
  let tailStart: number | undefined

  for (; tailIndex >= headIndex && tailBudget > 0; tailIndex--) {
    const segment = segments[tailIndex]

    if (segment === undefined) break

    if (segment.type === 'image') {
      if (tailIndex === headIndex) break
      tail.unshift(segment)
      continue
    }

    const available =
      tailIndex === headIndex ? segment.text.length - headPartial : segment.text.length

    if (available <= tailBudget && tailIndex !== headIndex) {
      tail.unshift(segment)
      tailBudget -= available
      continue
    }

    tailStart = tailCut(segment.text, segment.text.length - Math.min(available, tailBudget))
    tail.unshift({ type: 'text', text: segment.text.slice(tailStart) })
    tailBudget = 0
    break
  }

  const keptText = textLength(head) + textLength(tail)
  const keptImages = [...head, ...tail].filter(segment => segment.type === 'image').length
  const allImages = segments.filter(segment => segment.type === 'image').length

  return [
    ...head,
    { type: 'text', text: omissionMarker(total - keptText, allImages - keptImages) },
    ...tail
  ]
}

const mergeText = (segments: ReadonlyArray<CodeModeResultSegment>) =>
  segments.reduce<Array<CodeModeResultSegment>>((merged, segment) => {
    const last = merged.at(-1)

    if (segment.type === 'text' && last?.type === 'text') {
      merged[merged.length - 1] = { type: 'text', text: last.text + segment.text }
    } else if (segment.type === 'image' || segment.text.length > 0) {
      merged.push(segment)
    }

    return merged
  }, [])

/** Agent `Content`: a plain string without images, ordered text and image parts otherwise. */
export const codeModeSegmentsContent = (
  segments: ReadonlyArray<CodeModeResultSegment>
): Content => {
  const merged = mergeText(segments)

  if (merged.every(segment => segment.type === 'text')) {
    return merged.map(segment => (segment.type === 'text' ? segment.text : '')).join('')
  }

  return merged.map(segment =>
    segment.type === 'text'
      ? TextPart.make({ text: segment.text })
      : ImagePart.make({
          source: inlineBase64AttachmentSource(segment.data),
          mimeType: segment.mimeType
        })
  )
}

export type CodeModeCallSummary = {
  readonly name: string
  readonly status: NestedToolCallStatus
}

const statusOrder: ReadonlyArray<NestedToolCallStatus> = ['ok', 'error', 'cancelled']

/** `name: 2 ok, 1 error; other: 1 cancelled`, by first appearance. */
export const summarizeCodeModeCalls = (calls: ReadonlyArray<CodeModeCallSummary>): string => {
  if (calls.length === 0) return 'none'

  const byName = new Map<string, Map<NestedToolCallStatus, number>>()

  for (const call of calls) {
    const counts = byName.get(call.name) ?? new Map<NestedToolCallStatus, number>()

    counts.set(call.status, (counts.get(call.status) ?? 0) + 1)
    byName.set(call.name, counts)
  }

  return [...byName]
    .map(
      ([name, counts]) =>
        `${name}: ${statusOrder
          .flatMap(status => {
            const count = counts.get(status)

            return count === undefined ? [] : [`${count} ${status}`]
          })
          .join(', ')}`
    )
    .join('; ')
}

const stackFrames = (stack: string | undefined) =>
  stack === undefined
    ? []
    : stack.split('\n').filter(line => /^\s+at\s/.test(line) || /^\s*\S+:\d+/.test(line))

const encodeValue = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '[unserializable value]'
  }
}

/** Default cap of images kept in one result. */
export const defaultCodeModeMaxImages = 8

/** Default cap of base64 image data kept in one result, in characters (4 MiB). */
export const defaultCodeModeMaxImageBytes = 4 * 1024 * 1024

const imageOmissionNote = (dropped: number, maxImages: number, maxImageBytes: number) =>
  `\n\n[… ${dropped} image${dropped === 1 ? '' : 's'} omitted: a result keeps at most ${maxImages} images and ${maxImageBytes} characters of base64 image data …]`

/**
 * Model-visible segments of one execution: a `Script completed` / `Script failed` header with the
 * wall time, the output in order, the JSON return value (omitted when undefined), and for failures
 * the error and the tool calls already made. Images are kept in order while they fit `maxImages`
 * (default 8) and `maxImageBytes` of base64 in total (default 4 MiB); an image that would exceed
 * either is dropped and counted in an omission note after the output. The result is then bounded
 * by `maxChars` with a head-and-tail cut, which also drops images in the omitted middle.
 */
export const codeModeResultSegments = (input: {
  readonly result: CodeModeExecutionResult
  readonly wallTimeMs: number
  readonly calls: ReadonlyArray<CodeModeCallSummary>
  readonly maxChars: number
  readonly maxImages?: number
  readonly maxImageBytes?: number
}): ReadonlyArray<CodeModeResultSegment> => {
  const { result } = input
  const maxImages = Math.max(0, Math.floor(input.maxImages ?? defaultCodeModeMaxImages))
  const maxImageBytes = Math.max(0, Math.floor(input.maxImageBytes ?? defaultCodeModeMaxImageBytes))
  const ms = Math.round(input.wallTimeMs)
  const segments: Array<CodeModeResultSegment> = []

  const text = (value: string) => {
    segments.push({ type: 'text', text: value })
  }

  text(result.ok ? `Script completed in ${ms} ms.` : `Script failed after ${ms} ms.`)

  if (result.output.length > 0) {
    text('\n\nOutput:\n')

    let keptImages = 0
    let keptImageBytes = 0
    let droppedImages = 0

    result.output.forEach((item, index) => {
      const previous = result.output[index - 1]

      if (item.type === 'text') {
        text(previous?.type === 'text' ? `\n${item.text}` : item.text)
      } else if (keptImages < maxImages && keptImageBytes + item.data.length <= maxImageBytes) {
        keptImages++
        keptImageBytes += item.data.length
        segments.push(item)
      } else {
        droppedImages++
      }
    })

    if (droppedImages > 0) text(imageOmissionNote(droppedImages, maxImages, maxImageBytes))
  }

  if (result.ok && result.value !== undefined) {
    text(`\n\nReturn value:\n${encodeValue(result.value)}`)
  }

  if (!result.ok) {
    const error = result.error ?? {
      kind: 'sandbox',
      message: 'The script failed without an error.'
    }

    text(`\n\nScript error: ${error.kind}: ${error.message}`)

    const frames = stackFrames(error.stack)

    if (frames.length > 0) text(`\n${frames.join('\n')}`)

    text(
      `\n\nTool calls made before the failure (they are not undone): ${summarizeCodeModeCalls(input.calls)}.`
    )
  }

  if (result.ok && result.output.length === 0 && result.value === undefined) {
    text(' No output and no return value.')
  }

  return boundCodeModeSegments(mergeText(segments), input.maxChars)
}
