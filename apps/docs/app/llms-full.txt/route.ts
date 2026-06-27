import { source } from '../../lib/source'
import { getLLMText } from '../../lib/get-llm-text'

export const revalidate = false

export async function GET() {
  const pages = await Promise.all(source.getPages().map(getLLMText))

  return new Response(pages.join('\n\n---\n\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8'
    }
  })
}
