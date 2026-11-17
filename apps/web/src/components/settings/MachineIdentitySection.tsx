import { AuthEnvironmentMaintainScope, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";

import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { useEnvironmentScope } from "../../state/session";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ManagedByOrganization } from "../ManagedPolicy";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The machine a page is about: its name and icon, its version and URL, and who manages it. */
export function MachineIdentitySection() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  if (environment === null || environmentId === null) return null;
  const serverConfig = environment.serverConfig;
  const managedPolicy = serverConfig?.managedPolicy;
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  return (
    <SettingsSection
      {...searchableSetting("connections-environment")}
      title={environment.label}
      icon={
        <EnvironmentMachineIcon
          aria-hidden
          kind={serverConfig ? resolveEnvironmentMachineKind(serverConfig) : "desktop"}
          className="size-4"
        />
      }
      headerAction={
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label="More actions for this machine"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <EnvironmentIconMenu environmentId={environmentId} serverConfig={serverConfig} />
          </MenuPopup>
        </Menu>
      }
    >
      {managedPolicy ? (
        <div className="px-3 py-2 sm:px-4">
          <ManagedByOrganization policy={managedPolicy} />
        </div>
      ) : null}
      {canMaintain ? (
        <SettingsRow
          title="Version"
          description={
            [serverConfig?.environment.serverVersion ?? null, environment.displayUrl ?? null]
              .filter((value): value is string => value !== null)
              .join(" · ") || "Loading…"
          }
          control={
            versionMismatch ? (
              <span className="text-xs text-muted-foreground">
                Older than this app ({versionMismatch.clientVersion})
              </span>
            ) : undefined
          }
        />
      ) : null}
    </SettingsSection>
  );
}
