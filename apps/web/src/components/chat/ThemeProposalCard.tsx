import type { ThemeProposal } from "@t3tools/shared/themeProposal";
import { PaletteIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useTheme } from "../../hooks/useTheme";
import {
  applyThemeProposal,
  getThemeProposalState,
  previewThemeProposal,
  stopThemeProposalPreview,
  subscribeThemeProposals,
  themeProposalAppliedHere,
  themeProposalDefinition,
  themeProposalReadable,
  undoThemeProposal,
} from "../../themeProposalApply";
import { Button } from "../ui/button";

/**
 * A theme an agent proposed. Showing it changes nothing; Preview, Apply and Undo act only in this
 * browser, for whoever clicks. `actions` is false where the viewer cannot act, such as a guest link.
 * The preview and the applied records are shared by every card (themeProposalApply's store).
 */
export function ThemeProposalCard({
  itemId,
  proposal,
  actions,
}: {
  readonly itemId: string;
  readonly proposal: ThemeProposal;
  readonly actions: boolean;
}) {
  const { theme } = useTheme();
  const shared = useSyncExternalStore(
    subscribeThemeProposals,
    getThemeProposalState,
    getThemeProposalState,
  );
  const [message, setMessage] = useState<string | null>(null);
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unmount cleanup only: this card's preview, painted on the document, must end when the card leaves the screen
  useEffect(() => () => stopThemeProposalPreview(itemId), [itemId]);

  const togglePreview = () => {
    if (previewing) stopThemeProposalPreview(itemId);
    else previewThemeProposal(itemId, proposal);
  };

  const apply = () => {
    const result = applyThemeProposal(itemId, proposal);
    setMessage(result.ok ? null : result.message);
  };

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
      {actions ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {applied ? (
            <Button size="xs" variant="outline" onClick={undo}>
              Undo
            </Button>
          ) : (
            <>
              <Button size="xs" disabled={!readable} onClick={apply}>
                Apply to my appearance
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!readable}
                aria-pressed={previewing}
                onClick={togglePreview}
              >
                {previewing ? "Stop preview" : "Preview"}
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            {applied ? "Applied in this browser only." : "Only you, in this browser."}
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
