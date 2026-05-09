'use client'

import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from '@/components/ui/input-otp'
import { LoaderCircleIcon, SendIcon } from 'lucide-react'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import Link from 'next/link'
import { authClient } from '@/lib/services/auth/auth-client'
import { useRouter } from 'next/navigation'

type Props = {
  email: string
}

export const OtpForm = ({ email }: Props) => {
  const [otp, setOtp] = useState('')
  const [isProcessing, startTransition] = useTransition()
  const [showError, setShowError] = useState(false)
  const router = useRouter()

  const handleChange = (value: string) => {
    setShowError(false)
    setOtp(value)
  }

  const handleSend = async () => {
    startTransition(async () => {
      const { error } = await authClient.signIn.emailOtp({
        email,
        otp
      })

      if (error) {
        setShowError(true)
        toast.error(`Login error: ${error.message}`)
        return
      }

      router.push('/')
    })
  }

  return (
    <div className="flex flex-col items-center justify-center text-center gap-8">
      <div className="flex flex-col justify-center items-center space-y-6">
        <SendIcon className="size-12 text-muted-foreground/40" />
        <h2 className="text-2xl font-semibold">
          If the account exists, we&apos;ve sent a verification code to {email}
        </h2>
      </div>

      <div className="h-6">
        {isProcessing ? (
          <LoaderCircleIcon className="animate-spin size-5" />
        ) : showError ? (
          <div className="text-red-500">Invalid code</div>
        ) : (
          <p className="text-base text-muted-foreground text-center">Enter the code to log in</p>
        )}
      </div>

      <InputOTP
        value={otp}
        onChange={handleChange}
        onComplete={handleSend}
        maxLength={6}
        disabled={isProcessing}
        autoFocus
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>

      <p className="text-muted-foreground text-sm text-center">
        We only send login codes to registered accounts. If you have an account but haven&apos;t
        received the code, check the spam folder.
        <Link href="/login" className="block underline">
          Request a new code
        </Link>
      </p>
    </div>
  )
}
