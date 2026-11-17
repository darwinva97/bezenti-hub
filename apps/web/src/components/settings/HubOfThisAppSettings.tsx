import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { savedConnectionSlots } from "~/connection/singleHub";
import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { signOutAndRemoveEnvironment } from "~/connection/onboarding";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";
import { KeptSavedConnectionsNotice } from "./KeptSavedConnectionsNotice";
import { EmptyRemoteEnvironments, SavedBackendListRow } from "./SavedEnvironmentRows";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The one Hub a desktop app that is not the Hub itself signs in to. A browser has nothing to
 * save: its Hub is the page's server.
 */
export function HubOfThisAppSettings() {
  const { environments } = useEnvironments();
  // Removing a saved environment also ends its session there (signing out of a Hub).
  const removeEnvironment = useAtomCommand(signOutAndRemoveEnvironment, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );
  const listedEnvironments = savedEnvironments.filter(
    (environment) => !isDesktopLocalConnectionTarget(environment.entry.target),
  );
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState<EnvironmentPresentation | null>(null);
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const handleAddBackendDialogOpenChange = (open: boolean) => {
    setAddBackendDialogOpen(open);
    if (open) {
      setRouteTarget(null);
    } else {
      setSavedBackendError(null);
    }
  };
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);

  const handleSetSavedBackendEnabled = async (environmentId: EnvironmentId, enabled: boolean) => {
    setSavedBackendError(null);
    const result = await setEnvironmentEnabled({ environmentId, enabled });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? error.message
          : `Failed to switch the backend ${enabled ? "on" : "off"}.`;
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not switch backend ${enabled ? "on" : "off"}`,
          description: message,
        }),
      );
    }
  };

  const removeSavedBackend = async (environment: EnvironmentPresentation) => {
    const environmentId = environment.environmentId;
    setRemovingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    const result = await removeEnvironment(environmentId);
    setRemovingSavedEnvironmentId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Failed to remove backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove backend",
          description: message,
        }),
      );
    }
  };

  const handleRemoveSavedBackend = async (environment: EnvironmentPresentation) => {
    const confirmed = await requestConfirmDialog(
      `Remove ${environment.label} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.`,
      { variant: "destructive" },
    );
    if (confirmed === true) await removeSavedBackend(environment);
  };

  return (
    <>
      <KeptSavedConnectionsNotice />
      {/* One connection, the Hub's: only a desktop that is not the Hub itself saves one. */}
      {savedConnectionSlots() > 0 ? (
        <SettingsSection
          {...searchableSetting("remote-environments")}
          title="Hub of this app"
          headerAction={
            savedEnvironments.length === 0 || routeTarget !== null ? (
              <div className="flex items-center gap-1">
                <AddEnvironmentDialog
                  open={addBackendDialogOpen}
                  routeTarget={routeTarget}
                  error={savedBackendError}
                  onOpenChange={handleAddBackendDialogOpenChange}
                  onErrorChange={setSavedBackendError}
                />
              </div>
            ) : null
          }
        >
          {listedEnvironments.map((environment) => (
            <SavedBackendListRow
              key={environment.environmentId}
              environment={environment}
              removingEnvironmentId={removingSavedEnvironmentId}
              onSetEnabled={handleSetSavedBackendEnabled}
              onRemove={handleRemoveSavedBackend}
              onAddRoute={(target) => {
                setRouteTarget(target);
                setSavedBackendError(null);
                setAddBackendDialogOpen(true);
              }}
            />
          ))}
          {savedEnvironments.length === 0 ? <EmptyRemoteEnvironments /> : null}
        </SettingsSection>
      ) : null}
    </>
  );
}
