import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  KnowledgeFileSource,
  KnowledgeTextSource,
  KnowledgeUrlSource
} from '@yolk-sdk/knowledge/documents'
import { KnowledgeExtractionError } from '@yolk-sdk/knowledge/errors'
import { KnowledgeExtractor } from '@yolk-sdk/knowledge/extraction'
import type { LoadedKnowledgeSource } from '@yolk-sdk/knowledge/extraction'
import { FileExtractionError, FileExtractor } from '../src/index.ts'
import type { FileInput } from '../src/index.ts'
import { FileKnowledgeExtractorLayer, makeFileKnowledgeExtractor } from '../src/knowledge.ts'
import { makeFileExtractorLayer } from '../src/node/index.ts'
import { encode, sourceWorkerUrl, workbook, xlsxMediaType } from './fixtures.ts'

const extract = (source: LoadedKnowledgeSource) =>
  Effect.gen(function* () {
    const extractor = yield* KnowledgeExtractor

    return yield* extractor.extract(source)
  })

/** The real Node extractor, its worker run from source. */
const NodeExtractorLayer = makeFileExtractorLayer({ isolation: { workerUrl: sourceWorkerUrl } })

const withNodeExtractor = <A, E>(effect: Effect.Effect<A, E, KnowledgeExtractor>) =>
  effect.pipe(Effect.provide(FileKnowledgeExtractorLayer.pipe(Layer.provide(NodeExtractorLayer))))

/** A fake `FileExtractor` that records its inputs. */
const recordingExtractor = (inputs: Array<FileInput>) =>
  FileKnowledgeExtractorLayer.pipe(
    Layer.provide(
      Layer.succeed(FileExtractor, {
        extract: input =>
          Effect.sync(() => {
            inputs.push(input)

            return { content: 'text', metadata: { format: 'text' } }
          })
      })
    )
  )

describe('FileKnowledgeExtractorLayer', () => {
  it.effect('passes string content through unchanged without calling the extractor', () =>
    Effect.gen(function* () {
      const inputs: Array<FileInput> = []

      const document = yield* extract({
        source: KnowledgeTextSource.make({ label: 'note' }),
        content: '  Already text  ',
        metadata: { origin: 'paste' }
      }).pipe(Effect.provide(recordingExtractor(inputs)))

      expect(document).toEqual({ content: '  Already text  ', metadata: { origin: 'paste' } })
      expect(inputs).toEqual([])
    })
  )

  it.effect('fails blank string content', () =>
    Effect.gen(function* () {
      const error = yield* extract({
        source: KnowledgeTextSource.make({}),
        content: '   '
      }).pipe(Effect.provide(recordingExtractor([])), Effect.flip)

      expect(error).toEqual(
        new KnowledgeExtractionError({ message: 'Knowledge source text is empty' })
      )
    })
  )

  it.effect('extracts bytes with the real Node extractor and keeps file metadata', () =>
    Effect.gen(function* () {
      const book = workbook([
        {
          name: 'Links',
          rows: [['Acme']],
          afterSheetData: '<hyperlinks><hyperlink ref="A1:XFD1048576" r:id="rId1"/></hyperlinks>',
          relationships: [['rId1', 'hyperlink', 'https://acme.example/', true]]
        }
      ])

      const document = yield* withNodeExtractor(
        extract({
          source: KnowledgeFileSource.make({ ref: 'blob/1', name: 'sites.xlsx' }),
          content: book,
          mediaType: xlsxMediaType,
          metadata: { owner: 'host', format: 'host-wins' }
        })
      )

      expect(document).toEqual({
        content: '# Links\nAcme <https://acme.example/>',
        title: 'sites.xlsx',
        metadata: { format: 'host-wins', sheetNames: ['Links'], owner: 'host' }
      })
    })
  )

  it.effect('derives the filename and media type from each source kind', () =>
    Effect.gen(function* () {
      const inputs: Array<FileInput> = []
      const layer = recordingExtractor(inputs)
      const bytes = encode('hello')

      yield* extract({
        source: KnowledgeFileSource.make({ ref: 'r2/key.pdf', mediaType: 'application/pdf' }),
        content: bytes
      }).pipe(Effect.provide(layer))

      yield* extract({
        source: KnowledgeUrlSource.make({ url: 'https://example.com/docs/My%20Report.docx?x=1' }),
        content: bytes,
        mediaType: 'application/octet-stream'
      }).pipe(Effect.provide(layer))

      yield* extract({ source: KnowledgeTextSource.make({}), content: bytes }).pipe(
        Effect.provide(layer)
      )

      expect(inputs.map(({ filename, mediaType }) => ({ filename, mediaType }))).toEqual([
        { filename: 'r2/key.pdf', mediaType: 'application/pdf' },
        { filename: 'My Report.docx', mediaType: 'application/octet-stream' },
        { filename: 'text', mediaType: 'text/plain' }
      ])
    })
  )

  it.effect('keeps malformed percent-escapes in URL filenames instead of throwing', () =>
    Effect.gen(function* () {
      const inputs: Array<FileInput> = []

      const extractor = makeFileKnowledgeExtractor({
        extract: input =>
          Effect.sync(() => {
            inputs.push(input)

            return { content: 'text', metadata: { format: 'text' } }
          })
      })

      const urls = ['https://example.test/%FF.txt', 'https://example.test/a%zz.pdf']

      // Building the Effect must not throw synchronously (decodeURIComponent raises URIError).
      const effects = urls.map(url =>
        extractor.extract({ source: KnowledgeUrlSource.make({ url }), content: encode('hello') })
      )

      for (const effect of effects) yield* effect

      expect(inputs.map(input => input.filename)).toEqual(['%FF.txt', 'a%zz.pdf'])
    })
  )

  it.effect('maps extractor failures to KnowledgeExtractionError with the cause', () =>
    Effect.gen(function* () {
      const cause = new FileExtractionError({ message: 'Could not read PDF', format: 'pdf' })

      const layer = FileKnowledgeExtractorLayer.pipe(
        Layer.provide(Layer.succeed(FileExtractor, { extract: () => Effect.fail(cause) }))
      )

      const error = yield* extract({
        source: KnowledgeFileSource.make({ ref: 'a.pdf' }),
        content: encode('%PDF')
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toEqual(new KnowledgeExtractionError({ message: 'Could not read PDF', cause }))
    })
  )

  it.effect('reports unsupported bytes through the real extractor', () =>
    Effect.gen(function* () {
      const error = yield* withNodeExtractor(
        extract({ source: KnowledgeFileSource.make({ ref: 'a.zip' }), content: encode('zip') })
      ).pipe(Effect.flip)

      expect(error.message).toBe('Unsupported file format: a.zip')
    })
  )
})
