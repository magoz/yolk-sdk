export const knowledgeSlugFromTitle = (title: string, id: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug.length === 0 ? id : `${slug}-${id}`
}
