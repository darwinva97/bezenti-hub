import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";

import { usePrimaryActsForInstallation } from "../../environments/primary";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useCloseAppModal } from "../sidebar/mainAppLocation";
import { LEGACY_MACHINE_PAGES, machineSettingsHref } from "./machineSettings";

/**
 * An old Settings page of a machine (`/settings/providers`...): it leads to the page of the
 * machine `?machine=` names when this app knows it, else to the Hub machine for the Owner, and
 * back to where Settings was opened for anyone else, who cannot open a machine.
 */
export function LegacyMachineRedirect({ path }: { readonly path: string }) {
  const page = LEGACY_MACHINE_PAGES[path];
  const search = useSearch({ strict: false }) as {
    readonly machine?: unknown;
    readonly instanceId?: unknown;
  };
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOpen = usePrimaryActsForInstallation();
  const closeAppModal = useCloseAppModal();
  const navigate = useNavigate();
  const machine = typeof search.machine === "string" ? search.machine : null;
  const knownMachine =
    machine !== null && environments.some((environment) => environment.environmentId === machine);
  const target =
    !canOpen || page === undefined
      ? null
      : machineSettingsHref({
          section: page.section,
          subpage: page.subpage,
          environmentId: knownMachine ? machine : null,
          primaryEnvironmentId,
          instanceId: typeof search.instanceId === "string" ? search.instanceId : undefined,
        });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an old link leads on to the machine page, or back to where Settings was opened
  useEffect(() => {
    if (target === null) void closeAppModal();
    else void navigate({ href: target, replace: true });
  }, [target, closeAppModal, navigate]);
  return null;
}
