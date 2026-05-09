'use client'

export default function Error({ error }: { error: Error & { digest?: string } }) {
  return (
    <div>
      <h2>Something went wrong</h2>
      <p className="whitespace-pre-wrap">{error.message}</p>
    </div>
  )
}
