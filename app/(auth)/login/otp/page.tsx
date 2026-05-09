import { Suspense } from 'react'
import { OtpForm } from './otp-form'

async function OtpContent({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const params = await searchParams
  const email = params.email ?? ''

  return <OtpForm email={email} />
}

export default function Page({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  return (
    <Suspense fallback={null}>
      <OtpContent searchParams={searchParams} />
    </Suspense>
  )
}
