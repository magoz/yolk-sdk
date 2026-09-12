// Shared by synchronous Next config and the Effect auth-config boundary.
export const getPortlessOrigin = (value: string): string => {
  const url = URL.parse(value)
  if (
    url === null ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname.includes('*') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Invalid PORTLESS_URL')
  }

  return url.origin
}
