import { Platform } from "react-native";

import { useSpaceSelections } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { navigationCustomizationAvailable } from "../workspace/navigation-tab-order";
import { spaceSubject, type SettingsModalContext } from "./settings-modals";

/**
 * Who is looking at Settings: the signed-in User of the Hub and its current Space. Without a Hub
 * the viewer is alone with their own devices and sees everything, as the Settings list did.
 */
export function useSettingsModalContext(): SettingsModalContext {
  const hub = useHubConnection();
  const selections = useSpaceSelections();
  const selection = hub === null ? undefined : selections.get(hub.environmentId);
  const view = selection?.view ?? null;
  return {
    principal: {
      // As on web, a Member of a Hub does not see the pages only its Owner changes.
      isOwner: hub === null || view?.isOwner !== false,
      isDesktop: false,
      hasUser: view !== null,
    },
    space: spaceSubject(view?.spaces ?? null, selection?.currentSpaceId ?? null),
    spaceId: selection?.currentSpaceId ?? null,
    device: {
      ios: Platform.OS === "ios",
      navigationCustomization: navigationCustomizationAvailable(),
    },
  };
}
