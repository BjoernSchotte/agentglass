import { Command as C } from "cmdk";
import type { ComponentProps } from "react";
import { cn } from "../cn.ts";
export function Command({ className, ...p }: ComponentProps<typeof C>) { return <C className={cn("flex flex-col", className)} {...p} />; }
export function CommandInput({ className, ...p }: ComponentProps<typeof C.Input>) { return <C.Input className={cn("h-11 w-full border-b border-border-subtle bg-transparent px-4 text-[14px] outline-none placeholder:text-muted", className)} {...p} />; }
export function CommandList({ className, ...p }: ComponentProps<typeof C.List>) { return <C.List className={cn("max-h-[50vh] overflow-y-auto p-1.5", className)} {...p} />; }
export function CommandGroup({ className, ...p }: ComponentProps<typeof C.Group>) { return <C.Group className={cn("[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted", className)} {...p} />; }
export function CommandItem({ className, ...p }: ComponentProps<typeof C.Item>) { return <C.Item className={cn("flex h-8 cursor-default items-center gap-2 rounded px-2 text-[13px] data-[selected=true]:bg-surface-2 data-[disabled=true]:opacity-50", className)} {...p} />; }
export function CommandEmpty(p: ComponentProps<typeof C.Empty>) { return <C.Empty className="px-3 py-6 text-center text-muted" {...p} />; }
