export const forwardHeaderNames = [
  'accept',
  'authorization',
  'content-type',
  'originator',
  'chatgpt-account-id'
] satisfies ReadonlyArray<string>

type ForwardHeaderName = (typeof forwardHeaderNames)[number]

type ForwardedHeaders = Partial<Record<ForwardHeaderName, string>>

export const forwardedHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
  const forwarded: ForwardedHeaders = {}

  for (const name of forwardHeaderNames) {
    const value = headers[name]

    if (value !== undefined) {
      forwarded[name] = value
    }
  }

  return forwarded
}
