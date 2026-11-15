import { refreshTheme } from "./hooks/useTheme";
import { useCurrentSpace } from "./state/currentSpace";
import { setThemeCssViewer, type ThemeCssViewer } from "./themeCss";
import { dropThemeCss, stopThemeProposalPreview } from "./themeProposalApply";

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

/** Sets whose CSS the page may show (dropping anyone else's) and repaints if that changed. */
export function syncThemeCssViewer(next: ThemeCssViewer): void {
  if (!setThemeCssViewer(next)) return;
  stopThemeProposalPreview();
  refreshTheme({ preservePreview: false });
}

/**
 * Follows the signed-in User from the Spaces store, which knows it after loading: however a
 * session ends (sign-out, expiry, revocation), the next viewer never gets another User's CSS.
 */
export function startThemeCssViewerTracking(): () => void {
  const sync = () => {
    const { environmentId, view, loadFailed } = useCurrentSpace.getState();
    syncThemeCssViewer(
      view !== null
        ? { kind: "user", userId: view.userId }
        : environmentId !== null && !loadFailed
          ? { kind: "none" }
          : { kind: "unknown" },
    );
  };
  sync();
  return useCurrentSpace.subscribe(sync);
}
