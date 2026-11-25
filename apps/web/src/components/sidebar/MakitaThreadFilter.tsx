import { BotIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

/**
 * The Thread list's «Makita» filter (Makita ticket 07): only the Threads of Makita's tasks. Shown
 * while the viewer has any (or the filter is on, so it can be turned off).
 */
export function MakitaThreadFilterButton({
  active,
  available,
  onToggle,
}: {
  readonly active: boolean;
  readonly available: boolean;
  readonly onToggle: () => void;
}) {
  if (!available && !active) return null;
  return (
    <SidebarHeaderIconButton
      label={active ? "Show every thread" : "Show only Makita threads"}
      aria-pressed={active}
      variant={active ? "outline" : "default"}
      onClick={onToggle}
    >
      <BotIcon />
    </SidebarHeaderIconButton>
  );
}
