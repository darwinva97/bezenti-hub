import type { SpaceSummary } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import { useCurrentSpace } from "../../state/currentSpace";

/**
 * The Space of the Space settings modal: the one its URL names, as the viewer's directory lists
 * it. Outside that modal, such as in the command palette, it is the current Space. Null while the
 * directory loads, and for a Space the viewer cannot see.
 */
export function useSettingsSpace(): SpaceSummary | null {
  const { spaceId } = useParams({ strict: false });
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  const spaces = useCurrentSpace((state) => state.view?.spaces);
  const wanted = spaceId ?? currentSpaceId;
  if (wanted === null) return null;
  return spaces?.find((space) => space.id === wanted) ?? null;
}
