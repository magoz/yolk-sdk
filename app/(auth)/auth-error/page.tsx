import { SmileIcon } from 'lucide-react'

export default function Page() {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-4">
      <div className="flex flex-col justify-center items-center">
        <SmileIcon className="h-8 w-8 text-muted-foreground mb-2 rotate-180" />
      </div>
      <p className="text-base text-muted-foreground text-center">
        There was an error signing you in.
        <br />
        Try again or contact support.
      </p>
    </div>
  )
}
