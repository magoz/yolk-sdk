import type { source } from './source'

export const getLLMText = async (page: (typeof source)['$inferPage']) => {
  const processed = await page.data.getText('processed')
  const description = page.data.description
  const descriptionText = description === undefined ? '' : `\n\n${description}`

  return `# ${page.data.title}\n\nURL: ${page.url}${descriptionText}\n\n${processed}`
}
