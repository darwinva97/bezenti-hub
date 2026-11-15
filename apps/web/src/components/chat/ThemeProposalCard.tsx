import type { ThemeProposal } from "@t3tools/shared/themeProposal";
import { PaletteIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTheme } from "../../hooks/useTheme";
import { themeCssViewerKey } from "../../themeCss";
import { THEME_CSS_RECOVERY_SHORTCUT } from "../../themeCssRecovery";
import {
  applyThemeProposal,
  getThemeProposalState,
  mountThemeProposalCard,
  previewThemeProposal,
  stopThemeProposalPreview,
  subscribeThemeProposals,
  themeProposalAppliedHere,
  themeProposalCssFromInput,
  themeProposalDefinition,
  themeProposalReadable,
  undoThemeProposal,
  type ThemeProposalApplyResult,
} from "../../themeProposalApply";
import { Button } from "../ui/button";

export const THEME_PROPOSAL_CSS_WARNING =
  "Includes custom CSS: it can change how anything on the page looks, including buttons";

function cssSize(length: number): string {
  return length < 1024 ? `${length} characters` : `${(length / 1024).toFixed(1)} KB`;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * A theme an agent proposed. Showing it changes nothing; Preview, Apply and Undo act only in this
 * browser. `actions` is false where the viewer cannot act, such as a guest link. A proposal's CSS
 * is read on the first Preview or Apply with `loadCssInput` (the stored tool call's input).
 */
export function ThemeProposalCard({
  itemId,
  proposal,
  actions,
  loadCssInput,
}: {
  readonly itemId: string;
  readonly proposal: ThemeProposal;
  readonly actions: boolean;
  readonly loadCssInput?: (() => Promise<unknown>) | undefined;
}) {
  const { theme } = useTheme();
  const shared = useSyncExternalStore(
    subscribeThemeProposals,
    getThemeProposalState,
    getThemeProposalState,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [css, setCss] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const definition = themeProposalDefinition(proposal);
  const readable = themeProposalReadable(proposal);
  const previewing = shared.previewing === itemId;
  // The record lives in localStorage: reading the version here makes the compiler re-read it after
  // every write or removal, and the theme after every selection.
  const applied =
    actions &&
    theme === definition.id &&
    shared.recordsVersion >= 0 &&
    themeProposalAppliedHere(itemId, proposal);

  // False once this card left the screen: an answer arriving later must not paint or save.
  const onScreen = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registration only: a preview, painted on the document, needs a card on screen and ends when the last one leaves
  useEffect(() => {
    onScreen.current = true;
    const leave = mountThemeProposalCard(itemId);
    return () => {
      onScreen.current = false;
      leave();
    };
  }, [itemId]);

  /** The proposal's CSS, loaded once and checked; undefined for a colors-only proposal. */
  const loadCss = async (): Promise<
    | { readonly ok: true; readonly css: string | undefined }
    | { readonly ok: false; readonly message: string }
  > => {
    if (proposal.css === undefined) return { ok: true, css: undefined };
    if (css !== null) return { ok: true, css };
    if (loadCssInput === undefined) {
      return { ok: false, message: "The proposal's CSS cannot be loaded here." };
    }
    setLoading(true);
    try {
      const found = themeProposalCssFromInput(proposal, await loadCssInput());
      if (found.ok) setCss(found.css);
      return found;
    } catch {
      return { ok: false, message: "The proposal's CSS could not be loaded." };
    } finally {
      setLoading(false);
    }
  };

  const act = async (run: (css: string | undefined) => ThemeProposalApplyResult) => {
    const clickedBy = themeCssViewerKey();
    const loaded = await loadCss();
    // The load can take seconds: the card may have left, or the session ended or changed hands.
    if (!onScreen.current || themeCssViewerKey() !== clickedBy) return;
    if (!loaded.ok) {
      setMessage(loaded.message);
      return;
    }
    const result = run(loaded.css);
    setMessage(result.ok ? null : result.message);
  };

  const togglePreview = () => {
    if (previewing) {
      stopThemeProposalPreview(itemId);
      return;
    }
    void act((loaded) => previewThemeProposal(itemId, proposal, loaded));
  };

  const apply = () => void act((loaded) => applyThemeProposal(itemId, proposal, loaded));

  const undo = () => {
    setMessage(undoThemeProposal(itemId) ? null : "The previous theme could not be restored.");
  };

  const { colors } = definition;
  return (
    <div
      data-theme-proposal-card=""
      className="min-w-0 rounded-xl border border-border bg-card p-3 text-card-foreground"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border"
          style={{ backgroundColor: colors.canvas, color: colors.text }}
        >
          <span className="text-sm font-semibold">Aa</span>
          <span className="ml-1 size-2.5 rounded-full" style={{ backgroundColor: colors.accent }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <PaletteIcon className="size-3.5 shrink-0" />
            Theme proposed by the agent
          </p>
          <p className="truncate font-medium">{proposal.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {proposal.appearance === "dark" ? "Dark" : "Light"} · {proposal.canvas} ·{" "}
            {proposal.accent}
          </p>
        </div>
      </div>
      {proposal.css === undefined ? null : (
        <div
          data-theme-proposal-css=""
          className="mt-2 flex items-start gap-1.5 text-xs text-warning-foreground"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0">
            {THEME_PROPOSAL_CSS_WARNING} ({cssSize(proposal.css.length)}).{" "}
            <span className="text-muted-foreground">
              If it hides the page, press{" "}
              {isMac ? THEME_CSS_RECOVERY_SHORTCUT.mac : THEME_CSS_RECOVERY_SHORTCUT.other} or open
              the app with ?safe-theme=1.
            </span>
          </p>
        </div>
      )}
      {actions ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {applied ? (
            <Button size="xs" variant="outline" onClick={undo}>
              Undo
            </Button>
          ) : (
            <>
              <Button size="xs" disabled={!readable || loading} onClick={apply}>
                Apply to my appearance
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!readable || loading}
                aria-pressed={previewing}
                onClick={togglePreview}
              >
                {previewing ? "Stop preview" : "Preview"}
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            {loading
              ? "Loading the CSS…"
              : applied
                ? "Applied in this browser only."
                : "Only you, in this browser."}
          </span>
        </div>
      ) : null}
      {readable ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          These colors would be hard to read, so they cannot be applied.
        </p>
      )}
      {message === null ? null : (
        <p role="status" className="mt-2 text-xs text-destructive-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
