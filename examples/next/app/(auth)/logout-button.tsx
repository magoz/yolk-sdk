'use client'

import { Slot } from '@radix-ui/react-slot'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/services/auth/auth-client'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

type LogoutButtonProps = ComponentProps<typeof Button> & {
  asChild?: boolean
}

export const LogoutButton = ({ className, asChild, ...props }: LogoutButtonProps) => {
  // const sendTelegram = useSendTelegram()

  const handleLogout = async () => {
    // const { data: session } = await authClient.getSession()
    // const email = session?.user.email ?? 'Unknown'

    authClient.signOut({
      fetchOptions: {
        onSuccess: async () => {
          // sendTelegram(`🚪 User logged out: ${email}`)

          // We cannot use router.push, or the layout will not be updated, since router.push doesn't revalidate layouts while using cache components
          window.location.href = '/'
        }
      }
    })
  }

  if (asChild) {
    return <Slot onClick={handleLogout} {...props} />
  }

  return <Button onClick={handleLogout} className={cn(className)} {...props} />
}
