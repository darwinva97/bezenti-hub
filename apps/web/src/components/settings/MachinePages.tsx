import { Link } from "@tanstack/react-router";

import { usePrimaryActsForInstallation } from "../../environments/primary";
import { isElectron } from "../../env";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { Button } from "../ui/button";
import { GrantsSettings } from "./GrantsSettings";
import { HubEnvironmentsSettings } from "./HubEnvironmentsSettings";
import { JoinedEnvironmentSetting } from "./JoinedEnvironmentSetting";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { MachineSettings } from "./MachineSettings";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
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

/** Where the saved connections can share pull request credentials: this computer and the ones joined. */
function UserPullRequestRouting() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const routable = [
    ...(primaryEnvironment ? [primaryEnvironment] : []),
    ...environments.filter(
      (environment) =>
        environment.entry.target._tag !== "PrimaryConnectionTarget" && environment.entry.enabled,
    ),
  ].filter((environment) => environment.connection.phase !== "unsupported");
  return <PullRequestRoutingSettings environments={routable} />;
}

/**
 * User → Machines: the User's own machines on the Hub (each linked to its page), and on the
 * desktop this computer and what this app does with it.
 */
export function UserMachinesSection() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOpenMachine = usePrimaryActsForInstallation();
  return (
    <SettingsPageContainer>
      <HubEnvironmentsSettings scope={{ kind: "user" }} />
      {isElectron ? (
        <>
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
                        params={{
                          environmentId: primaryEnvironmentId,
                          machineSection: "providers",
                        }}
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
        </>
      ) : null}
      {/* Grants adds what is lent to and by the User; until its sections exist, it stays here. */}
      <GrantsSettings />
      <UserPullRequestRouting />
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
