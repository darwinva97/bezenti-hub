import type { SpaceSummary } from "@t3tools/contracts";

import { useSpaceSelections } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";

/**
 * The Hub and the Organization the Space entry is about: the Hub's current Space, when it is an
 * Organization. Null in a Personal space, without a Hub, or before its directory loads.
 */
export function useSettingsOrganization() {
  const hub = useHubConnection();
  const selections = useSpaceSelections();
  const selection = hub === null ? undefined : selections.get(hub.environmentId);
  const space: SpaceSummary | undefined = selection?.view?.spaces.find(
    (candidate) => candidate.id === selection.currentSpaceId,
  );
  return hub !== null && space?.kind === "organization" ? { hub, space } : null;
}
