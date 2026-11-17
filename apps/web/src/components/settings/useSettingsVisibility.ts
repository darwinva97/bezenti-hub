import { isElectron } from "~/env";
import { usePrimaryActsForInstallation, usePrimarySessionState } from "~/environments/primary";

import type { SettingsVisibilityContext } from "./settingsModals";
import { useSettingsSpace } from "./useSettingsSpace";

/** Who is looking at Settings, as the modals' visibility rules read it. */
export function useSettingsVisibility(): SettingsVisibilityContext {
  const isOwner = usePrimaryActsForInstallation();
  const { data } = usePrimarySessionState();
  // Until the session is read, it answers yes, as `usePrimaryActsForInstallation` does.
  const hasUser = data === null || !data.authenticated || data.userId !== undefined;
  // In a Space's modal, the Space it names; elsewhere there is none.
  const space = useSettingsSpace();
  return {
    isOwner,
    isDesktop: isElectron,
    hasUser,
    space:
      space === null ? null : { kind: space.kind, isOwn: space.isOwn, canInvite: space.canInvite },
  };
}
