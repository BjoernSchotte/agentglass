import type { ComponentProps } from "react";
import { cn } from "../cn.ts";
export function Badge({ className, ...p }: ComponentProps<"span">) {
  return <span className={cn("inline-flex items-center rounded border border-border-subtle bg-surface-2 px-1.5 text-[11px] text-muted", className)} {...p} />;
}
export function Kbd({ className, ...p }: ComponentProps<"kbd">) {
  return <kbd className={cn("mono inline-flex min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 text-[11px] text-muted", className)} {...p} />;
}
