"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn("peer group/switch relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-all focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-primary data-unchecked:bg-input data-disabled:opacity-50", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="pointer-events-none block size-4 rounded-full bg-background transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0.5" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
