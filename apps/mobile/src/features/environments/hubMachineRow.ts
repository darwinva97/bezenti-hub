import {
  ENVIRONMENT_USE_LABELS,
  environmentStatusLabel,
  environmentUseDescription,
  environmentUseOf,
  shownEnvironmentStatus,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentOverviewEntry, HubEnvironmentSummary } from "@t3tools/contracts";

/** A machine of a list: a lent one (Grants) also says who lent it. */
export type HubMachineEntry = HubEnvironmentOverviewEntry & {
  readonly lent?: HubEnvironmentSummary["lent"];
};

/**
 * One machine as the Owner's list shows it: its status in words, how it is used with its Space
 * or owner («Dedicated to Acme», «Sandbox of Acme», «Grace's personal machine»), its system and
 * its running Threads; the same words and status as web's Settings → Environments.
 */
export function hubMachineRow(
  environment: HubMachineEntry,
  /** The Owner reading the list: their own machine is «Your personal machine». */
  viewerUserId?: string,
) {
  const status = shownEnvironmentStatus(environment);
  const statusLabel = environmentStatusLabel(status, environment.kind);
  const use = environmentUseDescription(environment, {
    spaceName: environment.spaceName,
    ownerName: environment.ownerName,
    viewerUserId,
  });
  const running =
    environment.runningThreadCount === 0
      ? null
      : `${environment.runningThreadCount} running ${environment.runningThreadCount === 1 ? "Thread" : "Threads"}`;
  const details = [statusLabel, use, environment.os, running]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return {
    status,
    // A machine lent to the Space: its lender controls it, so it says so beside its name.
    mode:
      environment.lent === undefined
        ? ENVIRONMENT_USE_LABELS[environmentUseOf(environment)]
        : "Lent machine",
    details,
    error: status === "failed" ? environment.startError : null,
    accessibilityLabel: `${environment.name}, ${details}`,
  };
}
