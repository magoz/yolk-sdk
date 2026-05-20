'use client'

import { Button } from '@/components/ui/button'
import type { FormEvent } from 'react'
import { useState, useTransition } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { formatEmail } from '@/lib/utils'
import { authClient } from '@/lib/services/auth/auth-client'
import { useRouter } from 'next/navigation'

export const LoginForm = () => {
  const [email, setEmail] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isProcessing, startTransition] = useTransition()
  const router = useRouter()

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      setErrorMessage(null)

      const { data, error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in'
      })

      if (error) {
        console.error('Error sending email', error)
        toast.error(`Login error: ${error.statusText}`)
        return setErrorMessage(error.statusText ?? 'Something went wrong. Try again later.')
      }

      if (data.success) {
        router.push(`/login/otp?email=${encodeURIComponent(email)}`)
      }
    })
  }

  return (
    <>
      <form onSubmit={handleLogin} className="w-full space-y-4">
        <Input
          id="email"
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(formatEmail(e.target.value))}
          autoFocus
          required
        />
        <Button type="submit" size="lg" className="w-full" disabled={isProcessing}>
          {isProcessing && <LoaderCircleIcon className="size-4 mr-1 animate-spin" />}
          Log in
        </Button>
      </form>

      {errorMessage && <p className="text-red-500 text-sm text-center mt-4 mb-8">{errorMessage}</p>}

      {/* <p className="text-center text-sm text-muted-foreground"> */}
      {/*   New user?{' '} */}
      {/*   <Link href="/register" className="text-primary hover:underline"> */}
      {/*     Create an account */}
      {/*   </Link> */}
      {/* </p> */}
    </>
  )
}
