import { Link } from "@tanstack/react-router";

import { usePrimaryActsForInstallation } from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { JoinedEnvironmentSetting } from "./JoinedEnvironmentSetting";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { MachineSettings } from "./MachineSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** Platform → Hub machine: the page of the machine that runs this Hub. */
export function HubMachineSection() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (primaryEnvironmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">The Hub machine is not connected yet.</p>
      </SettingsPageContainer>
    );
  }
  return <MachineSettings base={{ kind: "hub" }} />;
}

/** User → Machines: on the desktop, this computer and what this app does with it. */
export function UserMachinesSection() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOpenMachine = usePrimaryActsForInstallation();
  return (
    <SettingsPageContainer>
      <SettingsSection id="this-computer" title="This computer">
        <SettingsRow
          title="Machine settings"
          description="Providers, source control, devices, maintenance and network access of this computer."
          control={
            canOpenMachine && primaryEnvironmentId !== null ? (
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/settings/user/machines/$environmentId/$machineSection"
                    params={{ environmentId: primaryEnvironmentId, machineSection: "providers" }}
                  />
                }
              >
                Open
              </Button>
            ) : undefined
          }
        />
      </SettingsSection>
      <SettingsSection id="this-app" title="This app">
        <LocalEnvironmentSetting />
        <JoinedEnvironmentSetting />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** User → Machines → a machine: its page, ready for the lists of machines to link to. */
export function UserMachinePage({ environmentId }: { readonly environmentId: string }) {
  return <MachineSettings base={{ kind: "user", environmentId }} />;
}

/** Space → Machines → a machine: its page, ready for the lists of machines to link to. */
export function SpaceMachinePage({
  spaceId,
  environmentId,
}: {
  readonly spaceId: string;
  readonly environmentId: string;
}) {
  return <MachineSettings base={{ kind: "space", spaceId, environmentId }} />;
}
