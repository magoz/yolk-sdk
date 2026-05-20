import { Array as Arr, pipe } from 'effect'

export const forwardHeaderNames = [
  'accept',
  'authorization',
  'content-type',
  'originator',
  'chatgpt-account-id'
] satisfies ReadonlyArray<string>

export const forwardedHeaders = (headers: Readonly<Record<string, string | undefined>>) =>
  pipe(
    forwardHeaderNames,
    Arr.reduce({}, (forwarded: Record<string, string>, name) => {
      const value = headers[name]

      return value === undefined ? forwarded : { ...forwarded, [name]: value }
    })
  )
