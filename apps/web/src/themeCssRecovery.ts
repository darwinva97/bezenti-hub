import { dropThemeCss } from "./themeProposalApply";

/**
 * The keyboard way out of custom theme CSS, which can hide Settings and the palette: a window
 * capture handler that needs nothing on screen, not a configurable keybinding (those go through UI
 * state CSS can break). Matched on the physical key, so every layout and AltGr work.
 */
export const THEME_CSS_RECOVERY_SHORTCUT = {
  mac: "Cmd+Option+Shift+0",
  other: "Ctrl+Alt+Shift+0",
} as const;

function isThemeCssRecoveryShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === "Digit0" && event.altKey && event.shiftKey && (event.ctrlKey || event.metaKey)
  );
}

export function installThemeCssRecoveryShortcut(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isThemeCssRecoveryShortcut(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dropThemeCss();
  };
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
