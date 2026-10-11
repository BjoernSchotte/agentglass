import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.ts";

const button = cva("inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors duration-100 disabled:opacity-50 disabled:pointer-events-none", {
  variants: {
    variant: { default: "bg-accent text-accent-fg hover:opacity-90", ghost: "text-muted hover:bg-surface-2 hover:text-text", outline: "border border-border bg-surface hover:bg-surface-2" },
    size: { sm: "h-7 px-2", md: "h-8 px-3", icon: "h-7 w-7 justify-center" },
  },
  defaultVariants: { variant: "ghost", size: "sm" },
});
export function Button({ className, variant, size, asChild, ...p }: ComponentProps<"button"> & VariantProps<typeof button> & { asChild?: boolean }) {
  const C = asChild ? Slot.Root : "button";
  return <C className={cn(button({ variant, size }), className)} {...p} />;
}
