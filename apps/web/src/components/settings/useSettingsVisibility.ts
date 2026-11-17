import { isElectron } from "~/env";
import { usePrimaryActsForInstallation } from "~/environments/primary";

import type { SettingsVisibilityContext } from "./settingsModals";

/** Who is looking at Settings, as the modals' visibility rules read it. */
export function useSettingsVisibility(): SettingsVisibilityContext {
  return { isOwner: usePrimaryActsForInstallation(), isDesktop: isElectron };
}
