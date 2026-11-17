import { useNavigate } from "@tanstack/react-router";

import { usePrimaryActsForInstallation } from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { machineSettingsHref, type MachineSettingsTarget } from "./machineSettings";

/**
 * Opens the page of a machine from where the machine shows up: the Thread or Project of the
 * context, else the Hub's. Whoever cannot open it (everyone but the Owner) gets `canOpen: false`,
 * so the link is not offered.
 */
export function useOpenMachineSettings() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOpen = usePrimaryActsForInstallation();
  const open = (target: Omit<MachineSettingsTarget, "primaryEnvironmentId">) => {
    if (!canOpen) return;
    void navigate({ href: machineSettingsHref({ ...target, primaryEnvironmentId }) });
  };
  return { canOpen, open };
}
