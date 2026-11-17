import type { ReactNode } from "react";

import { usePrimaryActsForInstallation } from "../../environments/primary";
import { SettingsPageContainer } from "./settingsLayout";
import { SETTINGS_OWNER_ONLY_PATHS, type SettingsPath } from "./settingsSearch";

// Pages whose settings are the whole Hub's: a Member reads them but changes none.
const SETTINGS_HUB_WIDE_PATHS: ReadonlySet<string> = new Set([
  "/settings/threads",
  "/settings/browser",
  "/settings/worktrees",
  "/settings/projects",
  "/settings/labs",
]);

const OWNER_ONLY_SETTINGS_NOTICE =
  "Only the Owner of this Hub changes its providers, AI gateway, devices, maintenance, source control and secrets.";
const HUB_WIDE_SETTINGS_NOTICE =
  "These settings apply to the whole Hub, so only its Owner changes them.";

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
  if (!SETTINGS_HUB_WIDE_PATHS.has(pathname)) return children;
  return (
    <>
      <p role="note" className="shrink-0 border-b px-5 py-2 text-sm text-muted-foreground">
        {HUB_WIDE_SETTINGS_NOTICE}
      </p>
      {children}
    </>
  );
}
