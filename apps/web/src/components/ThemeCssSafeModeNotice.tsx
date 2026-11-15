import { useState, useSyncExternalStore } from "react";

import { hasStoredThemeCss, subscribeThemeCssSafeMode, themeCssSafeMode } from "../themeCss";
import { dropThemeCss } from "../themeProposalApply";
import { Button } from "./ui/button";

/**
 * Shown when the app was opened with `?safe-theme=1`: custom theme CSS is off for this visit, and
 * this offers to remove it from the browser for good.
 */
export function ThemeCssSafeModeNotice() {
  const safeMode = useSyncExternalStore(subscribeThemeCssSafeMode, themeCssSafeMode, () => false);
  const [stored, setStored] = useState(hasStoredThemeCss);
  const [dismissed, setDismissed] = useState(false);
  if (!safeMode || dismissed) return null;

  const remove = () => {
    dropThemeCss();
    setStored(hasStoredThemeCss());
  };

  return (
    <div
      role="region"
      aria-label="Safe theme"
      data-theme-css-safe-mode=""
      className="fixed inset-x-3 bottom-3 z-[2147483647] mx-auto flex max-w-xl flex-wrap items-center gap-2 rounded-xl border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <p className="min-w-0 flex-1">
        {stored
          ? "Safe theme: custom theme CSS is off for this visit."
          : "Safe theme: no custom theme CSS is saved in this browser."}
      </p>
      {stored ? (
        <Button size="sm" onClick={remove}>
          Remove custom theme CSS
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        Dismiss
      </Button>
    </div>
  );
}
