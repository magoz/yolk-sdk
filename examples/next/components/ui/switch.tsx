'use client'

import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from '@/lib/utils'

function Switch({ className, children, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent bg-input shadow-xs outline-none transition-[background-color,box-shadow] focus-visible:ring-[3px] data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 dark:bg-input/80',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-5 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform data-[checked]:translate-x-5 data-[unchecked]:translate-x-0.5"
      />
      {children}
    </SwitchPrimitive.Root>
  )
}

export { Switch }
