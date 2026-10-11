import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";
export function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal><T.Content sideOffset={4} className="rounded border border-border bg-surface-2 px-2 py-1 text-[12px] text-text shadow">{label}</T.Content></T.Portal>
    </T.Root>
  );
}
export const TipProvider = T.Provider;
