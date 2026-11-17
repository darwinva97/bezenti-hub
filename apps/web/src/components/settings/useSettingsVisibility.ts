import { isElectron } from "~/env";
import { usePrimaryActsForInstallation, usePrimarySessionState } from "~/environments/primary";

import type { SettingsVisibilityContext } from "./settingsModals";

/** Who is looking at Settings, as the modals' visibility rules read it. */
export function useSettingsVisibility(): SettingsVisibilityContext {
  const isOwner = usePrimaryActsForInstallation();
  const { data } = usePrimarySessionState();
  // Until the session is read, it answers yes, as `usePrimaryActsForInstallation` does.
  const hasUser = data === null || !data.authenticated || data.userId !== undefined;
  return { isOwner, isDesktop: isElectron, hasUser };
}
