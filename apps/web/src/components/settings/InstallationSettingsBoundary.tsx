import type { ReactNode } from "react";

import { usePrimaryActsForInstallation } from "../../environments/primary";
import { SettingsPageContainer } from "./settingsLayout";
import { SETTINGS_OWNER_ONLY_PATHS, type SettingsPath } from "./settingsSearch";

const OWNER_ONLY_SETTINGS_NOTICE =
  "Only the Owner of this Hub changes its providers, devices, maintenance, source control and secrets.";

/** What a Member of a Hub sees of its Settings: the Owner's pages explained, not shown. */
export function InstallationSettingsBoundary({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const actsForInstallation = usePrimaryActsForInstallation();
  if (actsForInstallation) return children;
  if (SETTINGS_OWNER_ONLY_PATHS.has(pathname as SettingsPath)) {
    return (
      <SettingsPageContainer>
        <p role="status" className="text-sm text-muted-foreground">
          {OWNER_ONLY_SETTINGS_NOTICE}
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}
