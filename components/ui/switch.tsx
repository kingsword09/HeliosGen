"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn("peer group/switch relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-colors focus-visible:ring-3 focus-visible:ring-switch-checked/50 data-checked:bg-switch-checked data-unchecked:bg-switch-unchecked data-disabled:cursor-not-allowed data-disabled:opacity-50 motion-reduce:transition-none", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="pointer-events-none block size-5 rounded-full bg-switch-thumb shadow-sm transition-[transform,background-color] data-checked:translate-x-5 data-checked:bg-switch-checked-thumb data-unchecked:translate-x-0.5 motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
