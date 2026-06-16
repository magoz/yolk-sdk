import { documentPartFromText, inferTextDocumentMimeType } from '@yolk-sdk/agent/protocol'

export const textFromBlob = (blob: Blob) => {
  if (typeof blob.text === 'function') return blob.text()
  if (typeof FileReader === 'undefined') return Promise.reject(new Error('Could not read text'))

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }

      reject(new Error('Could not read text'))
    })
    reader.addEventListener('error', () => reject(new Error('Could not read text')))
    reader.addEventListener('abort', () => reject(new Error('Could not read text')))
    reader.readAsText(blob)
  })
}

export const documentPartFromTextFile = async (
  file: File,
  options?: {
    readonly title?: string
  }
) => {
  const mimeType = inferTextDocumentMimeType({
    filename: file.name,
    mimeType: file.type
  })

  if (mimeType === undefined) return undefined

  const text = await textFromBlob(file)

  return documentPartFromText({
    text,
    filename: file.name,
    mimeType,
    title: options?.title
  })
}
