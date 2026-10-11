import { Dialog as D } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn.ts";
export const Dialog = D.Root;
export function DialogContent({ className, title, children, side, ...p }: ComponentProps<typeof D.Content> & { title: string; children: ReactNode; side?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 bg-black/40" />
      <D.Content aria-describedby={undefined} className={cn(side ? "fixed inset-y-0 right-0 w-[min(560px,100vw)] border-l" : "fixed left-1/2 top-[12vh] w-[min(640px,92vw)] -translate-x-1/2 rounded-lg border", "border-border bg-surface shadow-xl outline-none", className)} {...p}>
        <D.Title className="sr-only">{title}</D.Title>
        {children}
      </D.Content>
    </D.Portal>
  );
}
