import { InfoIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * An explanation kept out of the page's flow: an «i» beside a title, its text on hover or focus.
 * For what a reader needs once, not for what they must see before acting.
 */
export function InfoTip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label={label} type="button">
            <InfoIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-sm">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}
