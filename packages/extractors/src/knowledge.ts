import { Effect, Layer, Match, Predicate } from 'effect'
import type { ExtractedKnowledgeDocument, KnowledgeSource } from '@yolk-sdk/knowledge/documents'
import { KnowledgeExtractionError } from '@yolk-sdk/knowledge/errors'
import { KnowledgeExtractor } from '@yolk-sdk/knowledge/extraction'
import type { KnowledgeExtractorApi, LoadedKnowledgeSource } from '@yolk-sdk/knowledge/extraction'
import type { ExtractedFile } from './format.ts'
import { FileExtractor } from './service.ts'
import type { FileExtractorApi } from './service.ts'

const urlFilename = (url: string) => {
  if (!URL.canParse(url)) return url

  const segments = new URL(url).pathname.split('/').filter(segment => segment.length > 0)
  const last = segments.at(-1)

  return last === undefined ? url : decodeURIComponent(last)
}

/** The filename used for format detection: file name or ref, URL path, or text label. */
const filenameFor = (source: KnowledgeSource) =>
  Match.value(source).pipe(
    Match.tagsExhaustive({
      File: file => file.name ?? file.ref,
      Url: url => urlFilename(url.url),
      Text: text => text.label ?? 'text'
    })
  )

/** Loaded media type first, then the file source's, then `text/plain` for text sources. */
const mediaTypeFor = (loaded: LoadedKnowledgeSource) => {
  if (loaded.mediaType !== undefined) return loaded.mediaType

  if (Predicate.isTagged(loaded.source, 'File') && loaded.source.mediaType !== undefined)
    return loaded.source.mediaType

  return Predicate.isTagged(loaded.source, 'Text') ? 'text/plain' : ''
}

const documentFrom = (
  loaded: LoadedKnowledgeSource,
  extracted: ExtractedFile
): ExtractedKnowledgeDocument => {
  const { title, ...fileMetadata } = extracted.metadata
  const metadata = { ...fileMetadata, ...loaded.metadata }

  return title === undefined || title.trim().length === 0
    ? { content: extracted.content, metadata }
    : { content: extracted.content, title: title.trim(), metadata }
}

/**
 * A `KnowledgeExtractor` backed by a `FileExtractor`. String content is already text and passes
 * through unchanged (it must not be blank); bytes are extracted with the format chosen from the
 * source name and media type. File metadata (`format`, `pageCount`, `sheetNames`) is merged
 * under the loaded source's own metadata, and the extracted title becomes the document title.
 */
export const makeFileKnowledgeExtractor = (extractor: FileExtractorApi): KnowledgeExtractorApi => ({
  extract: loaded => {
    if (Predicate.isString(loaded.content)) {
      const content = loaded.content

      return content.trim().length === 0
        ? Effect.fail(new KnowledgeExtractionError({ message: 'Knowledge source text is empty' }))
        : Effect.succeed(
            loaded.metadata === undefined ? { content } : { content, metadata: loaded.metadata }
          )
    }

    return extractor
      .extract({
        filename: filenameFor(loaded.source),
        mediaType: mediaTypeFor(loaded),
        bytes: loaded.content
      })
      .pipe(
        Effect.map(extracted => documentFrom(loaded, extracted)),
        Effect.mapError(
          error => new KnowledgeExtractionError({ message: error.message, cause: error })
        )
      )
  }
})

/** Provide `KnowledgeExtractor` from the `FileExtractor` in context (for example the Node layer). */
export const FileKnowledgeExtractorLayer = Layer.effect(
  KnowledgeExtractor,
  Effect.gen(function* () {
    const extractor = yield* FileExtractor

    return KnowledgeExtractor.of(makeFileKnowledgeExtractor(extractor))
  })
)
